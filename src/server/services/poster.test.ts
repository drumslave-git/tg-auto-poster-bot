import type { Api } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../test/db.js';
import { upsertChannel, getChannel, touchLastPost } from './channels.js';
import { getSchedule, postNext, resolveTarget, syncQueueHead, targetErrorMessage } from './poster.js';
import { enqueue, listQueue, peekNext, recentPosts, removeQueueItem } from './queue.js';
import { ensureSettings, updateSettings } from './settings.js';

/** Just the four calls the poster makes on grammY's Api. */
function fakeApi() {
  return {
    setMessageReaction: vi.fn(async (_chatId: string, _messageId: number, _reaction: unknown) => true),
    copyMessage: vi.fn(async (_chatId: string, _fromChatId: string, _messageId: number) => ({
      message_id: 555,
    })),
    copyMessages: vi.fn(async (_chatId: string, _fromChatId: string, _messageIds: number[]) => [
      { message_id: 555 },
      { message_id: 556 },
    ]),
    sendMessage: vi.fn(async (_chatId: string, _text: string, _options?: unknown) => ({
      message_id: 1,
    })),
  };
}

type FakeApi = ReturnType<typeof fakeApi>;

const asApi = (api: FakeApi) => api as unknown as Api;

function addChannel(chatId: string, status = 'administrator'): void {
  upsertChannel({ chatId, title: `Channel ${chatId}`, status, canPost: true });
}

function queueItem(messageIds = [1]) {
  return enqueue({
    sourceChatId: '42',
    sourceMessageIds: messageIds,
    kind: messageIds.length > 1 ? 'album' : 'single',
    contentType: messageIds.length > 1 ? 'album' : 'text',
    preview: 'hello',
  });
}

let api: FakeApi;

beforeEach(async () => {
  resetDb();
  ensureSettings();
  api = fakeApi();
  // The queue-head marker is module state; an empty queue clears it.
  await syncQueueHead(asApi(api));
  api.setMessageReaction.mockClear();
});

describe('resolveTarget', () => {
  it('fails when the bot administers nothing', () => {
    expect(resolveTarget()).toEqual({ ok: false, reason: 'no-channels' });
  });

  it('picks the only channel the bot administers', () => {
    addChannel('-1001');
    addChannel('-1002', 'member');

    const target = resolveTarget();

    expect(target.ok).toBe(true);
    expect(target.ok && target.channel.chatId).toBe('-1001');
  });

  it('refuses to guess between several channels', () => {
    addChannel('-1001');
    addChannel('-1002');

    expect(resolveTarget()).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('uses the configured channel even when others are available', () => {
    addChannel('-1001');
    addChannel('-1002');
    updateSettings({ targetChannelId: '-1002' });

    const target = resolveTarget();

    expect(target.ok && target.channel.chatId).toBe('-1002');
  });

  it('fails when the configured channel is unknown', () => {
    addChannel('-1001');
    updateSettings({ targetChannelId: '-100404' });

    expect(resolveTarget()).toEqual({ ok: false, reason: 'no-channels' });
  });

  it('fails when the bot lost its admin rights in the configured channel', () => {
    addChannel('-1001', 'member');
    updateSettings({ targetChannelId: '-1001' });

    expect(resolveTarget()).toEqual({ ok: false, reason: 'not-admin' });
  });

  it('accepts a channel the bot created', () => {
    addChannel('-1001', 'creator');
    updateSettings({ targetChannelId: '-1001' });

    expect(resolveTarget().ok).toBe(true);
  });
});

describe('targetErrorMessage', () => {
  it('explains each reason', () => {
    expect(targetErrorMessage('no-channels')).toMatch(/administrator/);
    expect(targetErrorMessage('ambiguous')).toMatch(/several channels/);
    expect(targetErrorMessage('not-admin')).toMatch(/no longer an administrator/);
  });
});

describe('getSchedule', () => {
  const now = new Date('2026-05-01T12:00:00Z');

  it('reports the blocking reason when there is no target', () => {
    queueItem();

    const schedule = getSchedule(now);

    expect(schedule).toMatchObject({
      targetChannelId: null,
      nextPostAt: null,
      dueNow: false,
      queueCount: 1,
      blocked: targetErrorMessage('no-channels'),
    });
  });

  it('counts down from the last message seen in the channel', () => {
    addChannel('-1001');
    touchLastPost('-1001', new Date(now.getTime() - 20 * 60_000));
    updateSettings({ delayMinutes: 60 });
    queueItem();

    const schedule = getSchedule(now);

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-01T12:40:00.000Z');
    expect(schedule.msRemaining).toBe(40 * 60_000);
    expect(schedule.dueNow).toBe(false);
    expect(schedule.blocked).toBeNull();
    expect(schedule.targetChannelTitle).toBe('Channel -1001');
  });

  it('is due once the delay has elapsed', () => {
    addChannel('-1001');
    touchLastPost('-1001', new Date(now.getTime() - 90 * 60_000));
    updateSettings({ delayMinutes: 60 });
    queueItem();

    const schedule = getSchedule(now);

    expect(schedule.msRemaining).toBe(0);
    expect(schedule.dueNow).toBe(true);
  });

  it('is due immediately in a channel with no recorded activity', () => {
    addChannel('-1001');
    queueItem();

    const schedule = getSchedule(now);

    expect(schedule.lastPostAt).toBeNull();
    expect(schedule.nextPostAt?.getTime()).toBe(now.getTime());
    expect(schedule.dueNow).toBe(true);
  });

  it('says the queue is empty rather than nothing at all', () => {
    addChannel('-1001');

    expect(getSchedule(now).blocked).toBe('Queue is empty.');
  });

  it('stops the countdown while paused, keeping the target', () => {
    addChannel('-1001');
    touchLastPost('-1001', new Date(now.getTime() - 90 * 60_000));
    queueItem();
    updateSettings({ paused: true });

    const schedule = getSchedule(now);

    expect(schedule).toMatchObject({
      targetChannelId: '-1001',
      nextPostAt: null,
      msRemaining: 0,
      dueNow: false,
      paused: true,
      blocked: 'Posting is paused.',
      queueCount: 1,
    });
  });
});

describe('syncQueueHead', () => {
  it('marks the head of the queue', async () => {
    const head = queueItem([11]);

    await syncQueueHead(asApi(api));

    expect(api.setMessageReaction).toHaveBeenCalledExactlyOnceWith('42', 11, [
      { type: 'emoji', emoji: '⚡' },
    ]);
    expect(head.id).toBe(peekNext()?.id);
  });

  it('does nothing when the head has not changed', async () => {
    queueItem([11]);
    await syncQueueHead(asApi(api));
    api.setMessageReaction.mockClear();

    await syncQueueHead(asApi(api));

    expect(api.setMessageReaction).not.toHaveBeenCalled();
  });

  it('unmarks the old head and marks the new one', async () => {
    const first = queueItem([11]);
    queueItem([12]);
    await syncQueueHead(asApi(api));
    api.setMessageReaction.mockClear();

    // The head left the queue without being published.
    removeQueueItem(first.id);
    await syncQueueHead(asApi(api));

    expect(api.setMessageReaction).toHaveBeenNthCalledWith(1, '42', 11, []);
    expect(api.setMessageReaction).toHaveBeenNthCalledWith(2, '42', 12, [
      { type: 'emoji', emoji: '⚡' },
    ]);
  });

  it('clears the mark when the queue empties', async () => {
    const only = queueItem([11]);
    await syncQueueHead(asApi(api));
    api.setMessageReaction.mockClear();

    removeQueueItem(only.id);
    await syncQueueHead(asApi(api));

    expect(api.setMessageReaction).toHaveBeenCalledExactlyOnceWith('42', 11, []);
  });

  it('survives a reaction the Telegram API rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.setMessageReaction.mockRejectedValue(new Error('MESSAGE_NOT_FOUND'));
    queueItem([11]);

    await expect(syncQueueHead(asApi(api))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('postNext', () => {
  it('refuses an empty queue', async () => {
    addChannel('-1001');

    expect(await postNext(asApi(api), 'auto')).toEqual({ ok: false, error: 'Queue is empty.' });
  });

  it('copies a single message and stamps the row as published', async () => {
    addChannel('-1001');
    const item = queueItem([11]);

    const result = await postNext(asApi(api), 'manual');

    expect(result).toEqual({
      ok: true,
      channelId: '-1001',
      channelMessageIds: [555],
      preview: 'hello',
      contentType: 'text',
    });
    expect(api.copyMessage).toHaveBeenCalledExactlyOnceWith('-1001', '42', 11);
    expect(api.copyMessages).not.toHaveBeenCalled();

    const [posted] = recentPosts();
    expect(posted).toMatchObject({ id: item.id, channelId: '-1001', mode: 'manual' });
    expect(listQueue()).toEqual([]);
  });

  it('copies an album in one call', async () => {
    addChannel('-1001');
    queueItem([11, 12]);

    const result = await postNext(asApi(api), 'auto');

    expect(result.ok && result.channelMessageIds).toEqual([555, 556]);
    expect(api.copyMessages).toHaveBeenCalledExactlyOnceWith('-1001', '42', [11, 12]);
    expect(api.copyMessage).not.toHaveBeenCalled();
  });

  it('restarts the countdown from the moment it posted', async () => {
    addChannel('-1001');
    queueItem([11]);
    expect(getChannel('-1001')?.lastPostAt).toBeNull();

    await postNext(asApi(api), 'auto');

    const [posted] = recentPosts();
    expect(getChannel('-1001')?.lastPostAt?.getTime()).toBe(posted?.postedAt.getTime());
  });

  it('thanks the sender and moves the mark to the next item', async () => {
    addChannel('-1001');
    queueItem([11]);
    queueItem([12]);
    await syncQueueHead(asApi(api));
    api.setMessageReaction.mockClear();

    await postNext(asApi(api), 'auto');

    expect(api.setMessageReaction).toHaveBeenNthCalledWith(1, '42', 11, [
      { type: 'emoji', emoji: '👍' },
    ]);
    expect(api.setMessageReaction).toHaveBeenNthCalledWith(2, '42', 12, [
      { type: 'emoji', emoji: '⚡' },
    ]);
  });

  it('reports a missing target back to the sender and keeps the post queued', async () => {
    const item = queueItem([11]);

    const result = await postNext(asApi(api), 'auto');

    expect(result).toEqual({ ok: false, error: targetErrorMessage('no-channels') });
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain(targetErrorMessage('no-channels'));
    expect(peekNext()?.id).toBe(item.id);
  });

  it('complains about the same failure only once', async () => {
    queueItem([11]);

    await postNext(asApi(api), 'auto');
    await postNext(asApi(api), 'auto');

    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it('reports a failed copy and leaves the post at the head of the queue', async () => {
    addChannel('-1001');
    const item = queueItem([11]);
    api.copyMessage.mockRejectedValue(new Error('CHAT_WRITE_FORBIDDEN'));

    const result = await postNext(asApi(api), 'auto');

    expect(result).toEqual({ ok: false, error: 'CHAT_WRITE_FORBIDDEN' });
    expect(peekNext()?.id).toBe(item.id);
    expect(recentPosts()).toEqual([]);
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain('CHAT_WRITE_FORBIDDEN');
  });

  it('survives a sender who blocked the bot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    addChannel('-1001');
    queueItem([11]);
    api.copyMessage.mockRejectedValue(new Error('CHAT_WRITE_FORBIDDEN'));
    api.sendMessage.mockRejectedValue(new Error('BOT_BLOCKED'));

    const result = await postNext(asApi(api), 'auto');

    expect(result).toEqual({ ok: false, error: 'CHAT_WRITE_FORBIDDEN' });
    expect(console.warn).toHaveBeenCalled();
  });

  it('lets only one post through at a time', async () => {
    addChannel('-1001');
    queueItem([11]);
    queueItem([12]);

    const [first, second] = await Promise.all([
      postNext(asApi(api), 'auto'),
      postNext(asApi(api), 'manual'),
    ]);

    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const failed = first.ok ? second : first;
    expect(failed).toEqual({ ok: false, error: 'A post is already in progress.' });
    expect(recentPosts()).toHaveLength(1);
  });
});

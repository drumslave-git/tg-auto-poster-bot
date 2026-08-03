import { eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { posts } from '../db/schema.js';
import { resetDb } from '../test/db.js';
import { upsertChannel, getChannel, touchLastPost } from './channels.js';
import { getSchedule, postNext, resolveTarget, syncQueueHead, targetErrorMessage } from './poster.js';
import {
  enqueue,
  listQueue,
  peekNext,
  recentPosts,
  removeQueueItem,
  type NewQueueItem,
} from './queue.js';
import { ensureSettings, updateSettings } from './settings.js';

/** Just the four calls the poster makes on grammY's Api. */
function fakeApi() {
  return {
    setMessageReaction: vi.fn(async (_chatId: string, _messageId: number, _reaction: unknown) => true),
    copyMessage: vi.fn(
      async (
        _chatId: string,
        _fromChatId: string,
        _messageId: number,
        _options?: { caption?: string; caption_entities?: unknown[] },
      ) => ({ message_id: 555 }),
    ),
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

function queueItem(messageIds = [1], extra: Partial<NewQueueItem> = {}) {
  return enqueue({
    sourceChatId: '42',
    sourceMessageIds: messageIds,
    kind: messageIds.length > 1 ? 'album' : 'single',
    contentType: messageIds.length > 1 ? 'album' : 'text',
    preview: 'hello',
    ...extra,
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

  it('projects when the queue empties at the current delay', () => {
    addChannel('-1001');
    updateSettings({ delayMinutes: 60 });
    queueItem([11]);
    queueItem([12]);
    queueItem([13]);

    const schedule = getSchedule(now);

    // Due immediately, then one an hour: the third goes out two hours later.
    expect(schedule.queueEmptiesAt?.toISOString()).toBe('2026-05-01T14:00:00.000Z');
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

describe('getSchedule — posting window', () => {
  /** 13:00–17:00, the example from the dashboard. */
  const afternoon = { windowStart: 13 * 60, windowEnd: 17 * 60 };

  beforeEach(() => {
    addChannel('-1001');
    updateSettings({ delayMinutes: 60, ...afternoon });
    queueItem([11]);
  });

  it('holds a due post until the window opens', () => {
    const schedule = getSchedule(new Date('2026-05-01T09:00:00Z'));

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-01T13:00:00.000Z');
    expect(schedule.dueNow).toBe(false);
    expect(schedule.blocked).toBe('Outside the posting window (13:00–17:00).');
    expect(schedule.window).toEqual({ start: '13:00', end: '17:00' });
  });

  it('posts straight away inside the window', () => {
    const schedule = getSchedule(new Date('2026-05-01T14:00:00Z'));

    expect(schedule.dueNow).toBe(true);
    expect(schedule.blocked).toBeNull();
  });

  it('leaves a countdown that ends inside the window alone', () => {
    touchLastPost('-1001', new Date('2026-05-01T13:10:00Z'));

    const schedule = getSchedule(new Date('2026-05-01T13:30:00Z'));

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-01T14:10:00.000Z');
    expect(schedule.dueNow).toBe(false);
  });

  it('carries a countdown that ends after closing over to the next day', () => {
    touchLastPost('-1001', new Date('2026-05-01T16:30:00Z'));

    const schedule = getSchedule(new Date('2026-05-01T16:40:00Z'));

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-02T13:00:00.000Z');
  });

  it('does not spill a missed window out after it closed', () => {
    // Due at 13:00, but nothing ran until 18:00 — the window is gone, and the
    // backlog waits for the next one instead of posting at night.
    touchLastPost('-1001', new Date('2026-05-01T12:00:00Z'));

    const schedule = getSchedule(new Date('2026-05-01T18:00:00Z'));

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-02T13:00:00.000Z');
    expect(schedule.dueNow).toBe(false);
  });

  it('reads the window in the configured time zone', () => {
    // 09:00 UTC is noon in Kyiv — an hour before the window opens there.
    updateSettings({ timezone: 'Europe/Kyiv' });

    const schedule = getSchedule(new Date('2026-05-01T09:00:00Z'));

    expect(schedule.nextPostAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
  });

  it('spans midnight when the start is after the end', () => {
    updateSettings({ windowStart: 22 * 60, windowEnd: 2 * 60 });

    expect(getSchedule(new Date('2026-05-01T23:30:00Z')).dueNow).toBe(true);
    expect(getSchedule(new Date('2026-05-01T01:00:00Z')).dueNow).toBe(true);
    expect(getSchedule(new Date('2026-05-01T12:00:00Z')).dueNow).toBe(false);
  });

  it('treats a window with no width as no window at all', () => {
    updateSettings({ windowStart: 13 * 60, windowEnd: 13 * 60 });

    const schedule = getSchedule(new Date('2026-05-01T03:00:00Z'));

    expect(schedule.window).toBeNull();
    expect(schedule.dueNow).toBe(true);
  });

  it('walks the window when projecting how long the queue lasts', () => {
    // Four fit in today's window (13, 14, 15, 16); the rest start again at 13.
    for (let extra = 0; extra < 5; extra += 1) queueItem([20 + extra]);

    const schedule = getSchedule(new Date('2026-05-01T13:00:00Z'));

    expect(schedule.queueCount).toBe(6);
    expect(schedule.queueEmptiesAt?.toISOString()).toBe('2026-05-02T14:00:00.000Z');
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

  describe('with a footer configured', () => {
    const footer = 'Subscribe to my awesome channel!';

    beforeEach(() => {
      addChannel('-1001');
      updateSettings({ postFooter: footer });
    });

    it('extends the caption of a media post as it is copied', async () => {
      queueItem([11], { contentType: 'photo', sourceText: 'a cat' });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage).toHaveBeenCalledExactlyOnceWith('-1001', '42', 11, {
        caption: `a cat\n\n${footer}`,
        caption_entities: [],
      });
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps the formatting the sender applied', async () => {
      const entities = [{ type: 'bold' as const, offset: 2, length: 3 }];
      queueItem([11], { contentType: 'photo', sourceText: 'a cat', sourceEntities: entities });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage.mock.calls[0]?.[3]).toMatchObject({ caption_entities: entities });
    });

    it('drops a custom emoji it has no right to send', async () => {
      queueItem([11], {
        contentType: 'photo',
        sourceText: 'a cat 🐈',
        sourceEntities: [
          { type: 'bold', offset: 0, length: 5 },
          { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5368324170671202286' },
        ],
      });

      await postNext(asApi(api), 'auto');

      // Restating it would be rejected, and the post would retry for ever.
      expect(api.copyMessage.mock.calls[0]?.[3]).toMatchObject({
        caption_entities: [{ type: 'bold', offset: 0, length: 5 }],
      });
    });

    it('makes the footer the whole caption when the media carries none', async () => {
      queueItem([11], { contentType: 'video', sourceText: '' });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage.mock.calls[0]?.[3]).toMatchObject({ caption: footer });
    });

    it('re-sends a text post, which has no caption to extend', async () => {
      queueItem([11], { contentType: 'text', sourceText: 'hello' });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage).not.toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('-1001', `hello\n\n${footer}`, {
        entities: [],
      });
    });

    it('follows an album with the footer as its own message', async () => {
      queueItem([11, 12], { sourceText: 'two pictures' });

      const result = await postNext(asApi(api), 'auto');

      expect(api.copyMessages).toHaveBeenCalledOnce();
      expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('-1001', footer);
      // The trailing message belongs to the post, so it is recorded with it.
      expect(result.ok && result.channelMessageIds).toEqual([555, 556, 1]);
    });

    it('does the same for a post with nothing to write on', async () => {
      queueItem([11], { contentType: 'sticker', sourceText: '' });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage).toHaveBeenCalledExactlyOnceWith('-1001', '42', 11);
      expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('-1001', footer);
    });

    it('copies a post queued before the text was kept untouched', async () => {
      const item = queueItem([11], { contentType: 'photo' });
      // Rows migrated from an older schema have no text to append to; replacing
      // their caption would throw the original away.
      db.update(posts).set({ sourceText: null }).where(eq(posts.id, item.id)).run();

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage).toHaveBeenCalledExactlyOnceWith('-1001', '42', 11);
      expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('-1001', footer);
    });

    it('shortens the post rather than the footer when both will not fit', async () => {
      queueItem([11], { contentType: 'photo', sourceText: 'x'.repeat(2000) });

      await postNext(asApi(api), 'auto');

      const caption = String(
        (api.copyMessage.mock.calls[0]?.[3] as { caption: string } | undefined)?.caption,
      );
      expect(caption).toHaveLength(1024);
      expect(caption.endsWith(`…\n\n${footer}`)).toBe(true);
    });

    it('publishes the post even when the trailing footer fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      queueItem([11, 12]);
      api.sendMessage.mockRejectedValue(new Error('CHAT_WRITE_FORBIDDEN'));

      const result = await postNext(asApi(api), 'auto');

      // Failing here would republish the whole album on the next tick.
      expect(result.ok).toBe(true);
      expect(result.ok && result.channelMessageIds).toEqual([555, 556]);
      expect(recentPosts()).toHaveLength(1);
    });

    it('leaves posts alone once the footer is cleared', async () => {
      updateSettings({ postFooter: null });
      queueItem([11], { contentType: 'photo', sourceText: 'a cat' });

      await postNext(asApi(api), 'auto');

      expect(api.copyMessage).toHaveBeenCalledExactlyOnceWith('-1001', '42', 11);
      expect(api.sendMessage).not.toHaveBeenCalled();
    });
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

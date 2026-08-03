import { beforeEach, describe, expect, it } from 'vitest';
import { upsertChannel, touchLastPost } from '../services/channels.js';
import { enqueue } from '../services/queue.js';
import { ensureSettings, updateSettings } from '../services/settings.js';
import { addUser } from '../services/users.js';
import { resetDb } from '../test/db.js';
import { buildSnapshot, maskToken } from './snapshot.js';

beforeEach(() => {
  resetDb();
  ensureSettings();
});

function queueItem(preview: string) {
  return enqueue({
    sourceChatId: '42',
    sourceMessageIds: [1],
    kind: 'single',
    contentType: 'text',
    preview,
  });
}

describe('maskToken', () => {
  it('passes null through', () => {
    expect(maskToken(null)).toBeNull();
  });

  it('keeps the bot id and the last four characters', () => {
    expect(maskToken('123456:AAEabcdefghijklmnopqXYZW')).toBe('123456:••••••••XYZW');
  });

  it('does not choke on a token without a colon', () => {
    expect(maskToken('nonsense')).toBe('nonsense:••••••••ense');
  });
});

describe('buildSnapshot', () => {
  it('describes an idle, unconfigured install', async () => {
    const snapshot = await buildSnapshot();

    expect(snapshot).toMatchObject({
      authRequired: false,
      bot: { status: 'stopped', error: null, username: null, id: null },
      users: [],
      channels: [],
      queue: [],
      settings: { delayMinutes: 60, timezone: 'UTC', hasToken: false, tokenMask: null, paused: false },
      scheduler: { running: false },
    });
    expect(new Date(snapshot.serverTime).getTime()).not.toBeNaN();
  });

  it('never leaks the bot token', async () => {
    updateSettings({ botToken: '123456:AAEabcdefghijklmnopqXYZW' });

    const snapshot = await buildSnapshot();

    expect(JSON.stringify(snapshot)).not.toContain('AAEabcdefghijklmnopqXYZW');
    expect(snapshot.settings).toMatchObject({ hasToken: true, tokenMask: '123456:••••••••XYZW' });
  });

  it('carries the people, the channels and the queue', async () => {
    addUser('100', 'admin', '@ada');
    upsertChannel({ chatId: '-1001', title: 'News', status: 'administrator', canPost: true });
    queueItem('first');
    queueItem('second');

    const snapshot = await buildSnapshot();

    expect(snapshot.users).toMatchObject([{ telegramId: '100', role: 'admin', label: '@ada' }]);
    expect(snapshot.channels.map((c) => c.chatId)).toEqual(['-1001']);
    expect(snapshot.queue.map((p) => p.preview)).toEqual(['first', 'second']);
    expect(snapshot.stats).toMatchObject({ queueCount: 2, postedCount: 0 });
  });

  it('projects the runway from the queue size and the delay', async () => {
    upsertChannel({ chatId: '-1001', title: 'News', status: 'administrator', canPost: true });
    touchLastPost('-1001', new Date(Date.now() - 30 * 60_000));
    updateSettings({ delayMinutes: 60 });
    queueItem('first');
    queueItem('second');
    queueItem('third');

    const { stats } = await buildSnapshot();

    expect(stats.runwayMs).toBe(3 * 60 * 60_000);
    expect(stats.targetChannelTitle).toBe('News');
    expect(stats.dueNow).toBe(false);
    // Three posts, one hour apart, starting at nextPostAt.
    const nextPostAt = new Date(stats.nextPostAt!).getTime();
    expect(new Date(stats.queueEmptiesAt!).getTime()).toBe(nextPostAt + 2 * 60 * 60_000);
  });

  it('has no queue-empties date while the queue is empty', async () => {
    upsertChannel({ chatId: '-1001', status: 'administrator', canPost: true });

    const { stats } = await buildSnapshot();

    expect(stats.runwayMs).toBe(0);
    expect(stats.queueEmptiesAt).toBeNull();
    expect(stats.blocked).toBe('Queue is empty.');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onDashboardChange } from '../events.js';
import { resetDb } from '../test/db.js';
import { getChannel, listChannels, postableChannels, touchLastPost, upsertChannel } from './channels.js';

beforeEach(() => {
  resetDb();
});

describe('upsertChannel', () => {
  it('inserts with sensible defaults', () => {
    upsertChannel({ chatId: '-1001' });

    expect(getChannel('-1001')).toMatchObject({
      chatId: '-1001',
      title: null,
      username: null,
      type: 'channel',
      status: 'member',
      canPost: false,
      lastPostAt: null,
    });
  });

  it('stores what it is given', () => {
    upsertChannel({
      chatId: '-1001',
      title: 'News',
      username: 'news',
      type: 'supergroup',
      status: 'administrator',
      canPost: true,
    });

    expect(getChannel('-1001')).toMatchObject({
      title: 'News',
      username: 'news',
      type: 'supergroup',
      status: 'administrator',
      canPost: true,
    });
  });

  it('only overwrites the fields present in the update', () => {
    upsertChannel({ chatId: '-1001', title: 'News', status: 'administrator', canPost: true });

    // A channel_post update carries the title but says nothing about membership.
    upsertChannel({ chatId: '-1001', title: 'News renamed', type: 'channel' });

    expect(getChannel('-1001')).toMatchObject({
      title: 'News renamed',
      status: 'administrator',
      canPost: true,
    });
    expect(listChannels()).toHaveLength(1);
  });

  it('can clear a field by passing null explicitly', () => {
    upsertChannel({ chatId: '-1001', username: 'news' });

    upsertChannel({ chatId: '-1001', username: null });

    expect(getChannel('-1001')?.username).toBeNull();
  });

  it('keeps the recorded activity across updates', () => {
    const at = new Date('2026-05-01T10:00:00Z');
    upsertChannel({ chatId: '-1001' });
    touchLastPost('-1001', at);

    upsertChannel({ chatId: '-1001', title: 'News' });

    expect(getChannel('-1001')?.lastPostAt?.getTime()).toBe(at.getTime());
  });

  it('tells the dashboard something changed', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);

    upsertChannel({ chatId: '-1001' });

    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe('touchLastPost', () => {
  it('records the latest activity', () => {
    upsertChannel({ chatId: '-1001' });
    const at = new Date('2026-05-01T10:00:00Z');

    touchLastPost('-1001', at);

    expect(getChannel('-1001')?.lastPostAt?.getTime()).toBe(at.getTime());
  });

  it('is a no-op for an unknown channel', () => {
    expect(() => touchLastPost('-100404', new Date())).not.toThrow();
    expect(getChannel('-100404')).toBeUndefined();
  });
});

describe('listChannels', () => {
  it('lists the most recently updated first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00Z'));
    upsertChannel({ chatId: '-100old' });
    vi.setSystemTime(new Date('2026-05-01T11:00:00Z'));
    upsertChannel({ chatId: '-100new' });
    vi.useRealTimers();

    expect(listChannels().map((c) => c.chatId)).toEqual(['-100new', '-100old']);
  });
});

describe('postableChannels', () => {
  it('keeps only the ones the bot administers', () => {
    upsertChannel({ chatId: '-100admin', status: 'administrator' });
    upsertChannel({ chatId: '-100creator', status: 'creator' });
    upsertChannel({ chatId: '-100member', status: 'member' });
    upsertChannel({ chatId: '-100left', status: 'left' });

    expect(postableChannels().map((c) => c.chatId).sort()).toEqual(['-100admin', '-100creator']);
  });

  it('is empty when there are no channels', () => {
    expect(postableChannels()).toEqual([]);
  });
});

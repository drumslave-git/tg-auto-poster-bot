import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onDashboardChange } from '../events.js';
import { resetDb } from '../test/db.js';
import {
  clearQueue,
  enqueue,
  listQueue,
  peekNext,
  postedCount,
  queueCount,
  recentPosts,
  recordPost,
  removeQueueItem,
  type NewQueueItem,
} from './queue.js';

function item(overrides: Partial<NewQueueItem> = {}): NewQueueItem {
  return {
    sourceChatId: '42',
    sourceMessageIds: [1],
    kind: 'single',
    contentType: 'text',
    preview: 'hello',
    ...overrides,
  };
}

function publish(id: number, at = new Date()) {
  return recordPost(id, {
    channelId: '-100999',
    channelMessageIds: [7],
    mode: 'auto',
    postedAt: at,
  });
}

beforeEach(() => {
  resetDb();
});

describe('enqueue', () => {
  it('returns the stored row', () => {
    const row = enqueue(item({ sourceMessageIds: [1, 2], kind: 'album', contentType: 'album' }));

    expect(row).toMatchObject({
      sourceChatId: '42',
      sourceMessageIds: [1, 2],
      kind: 'album',
      contentType: 'album',
      preview: 'hello',
      postedAt: null,
    });
    expect(row.id).toBeGreaterThan(0);
  });

  it('tells the dashboard something changed', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);

    enqueue(item());

    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe('peekNext and listQueue', () => {
  it('are FIFO', () => {
    const first = enqueue(item({ preview: 'first' }));
    enqueue(item({ preview: 'second' }));

    expect(peekNext()?.id).toBe(first.id);
    expect(listQueue().map((p) => p.preview)).toEqual(['first', 'second']);
  });

  it('ignore published posts', () => {
    const first = enqueue(item({ preview: 'first' }));
    const second = enqueue(item({ preview: 'second' }));
    publish(first.id);

    expect(peekNext()?.id).toBe(second.id);
    expect(listQueue()).toHaveLength(1);
    expect(queueCount()).toBe(1);
  });

  it('return nothing on an empty queue', () => {
    expect(peekNext()).toBeUndefined();
    expect(listQueue()).toEqual([]);
    expect(queueCount()).toBe(0);
  });

  it('respect the limit', () => {
    enqueue(item());
    enqueue(item());
    enqueue(item());

    expect(listQueue(2)).toHaveLength(2);
  });
});

describe('removeQueueItem', () => {
  it('drops a queued post', () => {
    const row = enqueue(item());

    expect(removeQueueItem(row.id)).toBe(true);
    expect(queueCount()).toBe(0);
  });

  it('refuses to touch history', () => {
    const row = enqueue(item());
    publish(row.id);

    expect(removeQueueItem(row.id)).toBe(false);
    expect(postedCount()).toBe(1);
  });

  it('reports a miss for an unknown id', () => {
    expect(removeQueueItem(9_999)).toBe(false);
  });
});

describe('clearQueue', () => {
  it('removes every queued post and returns the count', () => {
    enqueue(item());
    enqueue(item());
    const published = enqueue(item());
    publish(published.id);

    expect(clearQueue()).toBe(2);
    expect(queueCount()).toBe(0);
    expect(postedCount()).toBe(1);
  });

  it('returns zero on an empty queue', () => {
    expect(clearQueue()).toBe(0);
  });
});

describe('recordPost', () => {
  it('stamps the queued row in place instead of creating a second one', () => {
    const row = enqueue(item({ preview: 'to publish' }));
    const at = new Date('2026-05-01T10:00:00Z');

    const posted = publish(row.id, at);

    expect(posted.id).toBe(row.id);
    expect(posted).toMatchObject({
      channelId: '-100999',
      channelMessageIds: [7],
      mode: 'auto',
      preview: 'to publish',
    });
    expect(posted.postedAt.getTime()).toBe(at.getTime());
    expect(queueCount()).toBe(0);
    expect(postedCount()).toBe(1);
  });
});

describe('recentPosts', () => {
  it('lists published posts newest first', () => {
    const older = enqueue(item({ preview: 'older' }));
    const newer = enqueue(item({ preview: 'newer' }));
    publish(older.id, new Date('2026-05-01T10:00:00Z'));
    publish(newer.id, new Date('2026-05-01T11:00:00Z'));

    expect(recentPosts().map((p) => p.preview)).toEqual(['newer', 'older']);
  });

  it('respects the limit and skips the queue', () => {
    const first = enqueue(item());
    const second = enqueue(item());
    enqueue(item());
    publish(first.id, new Date('2026-05-01T10:00:00Z'));
    publish(second.id, new Date('2026-05-01T11:00:00Z'));

    expect(recentPosts(1)).toHaveLength(1);
    expect(recentPosts().every((p) => p.postedAt !== null)).toBe(true);
  });
});

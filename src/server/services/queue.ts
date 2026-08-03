import { asc, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { posts, queueItems, type Post, type QueueItem } from '../db/schema.js';
import { notifyDashboard } from '../events.js';

export type NewQueueItem = {
  sourceChatId: string;
  messageIds: number[];
  kind: 'single' | 'album';
  contentType: string;
  preview: string;
};

export function enqueue(item: NewQueueItem): QueueItem {
  const row = db
    .insert(queueItems)
    .values({ ...item, createdAt: new Date() })
    .returning()
    .get();
  notifyDashboard();
  return row;
}

/** FIFO: the oldest item is always the next one out. */
export function peekNext(): QueueItem | undefined {
  return db.select().from(queueItems).orderBy(asc(queueItems.id)).limit(1).get();
}

export function listQueue(limit = 200): QueueItem[] {
  return db.select().from(queueItems).orderBy(asc(queueItems.id)).limit(limit).all();
}

export function queueCount(): number {
  return db.select({ value: count() }).from(queueItems).get()?.value ?? 0;
}

export function removeQueueItem(id: number): boolean {
  const removed = db.delete(queueItems).where(eq(queueItems.id, id)).run().changes > 0;
  if (removed) notifyDashboard();
  return removed;
}

export function clearQueue(): number {
  const removed = db.delete(queueItems).run().changes;
  if (removed > 0) notifyDashboard();
  return removed;
}

export function recordPost(post: {
  channelId: string;
  messageIds: number[];
  contentType: string;
  preview: string;
  mode: 'auto' | 'manual';
  postedAt: Date;
}): Post {
  const row = db.insert(posts).values(post).returning().get();
  notifyDashboard();
  return row;
}

export function postedCount(): number {
  return db.select({ value: count() }).from(posts).get()?.value ?? 0;
}

export function recentPosts(limit = 10): Post[] {
  return db.select().from(posts).orderBy(desc(posts.postedAt)).limit(limit).all();
}

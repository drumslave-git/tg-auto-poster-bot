import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { MessageEntity } from 'grammy/types';
import { db } from '../db/index.js';
import {
  posts,
  type PostKind,
  type PostMode,
  type PublishedPost,
  type QueuedPost,
} from '../db/schema.js';
import { notifyDashboard } from '../events.js';

/** Queued and published posts share one table; `posted_at` tells them apart. */
const queued = isNull(posts.postedAt);
const published = isNotNull(posts.postedAt);

export type NewQueueItem = {
  sourceChatId: string;
  sourceMessageIds: number[];
  kind: PostKind;
  contentType: string;
  preview: string;
  /** The post's own words, kept verbatim so a footer can be appended to them. */
  sourceText?: string;
  sourceEntities?: MessageEntity[];
};

export function enqueue(item: NewQueueItem): QueuedPost {
  const row = db
    .insert(posts)
    .values({
      ...item,
      // Anything we queue ourselves records its text, even when there is none.
      // Null stays reserved for rows written before the bot kept it, whose
      // caption cannot be rebuilt and so must be copied untouched.
      sourceText: item.sourceText ?? '',
      sourceEntities: item.sourceEntities ?? [],
      createdAt: new Date(),
    })
    .returning()
    .get();
  notifyDashboard();
  return row as QueuedPost;
}

/** FIFO: the oldest queued post is always the next one out. */
export function peekNext(): QueuedPost | undefined {
  return db.select().from(posts).where(queued).orderBy(asc(posts.id)).limit(1).get() as
    | QueuedPost
    | undefined;
}

export function listQueue(limit = 200): QueuedPost[] {
  return db
    .select()
    .from(posts)
    .where(queued)
    .orderBy(asc(posts.id))
    .limit(limit)
    .all() as QueuedPost[];
}

export function queueCount(): number {
  return db.select({ value: count() }).from(posts).where(queued).get()?.value ?? 0;
}

/** Only queued posts can be dropped this way; history is never deleted. */
export function removeQueueItem(id: number): boolean {
  const removed = db.delete(posts).where(and(eq(posts.id, id), queued)).run().changes > 0;
  if (removed) notifyDashboard();
  return removed;
}

export function clearQueue(): number {
  const removed = db.delete(posts).where(queued).run().changes;
  if (removed > 0) notifyDashboard();
  return removed;
}

/** Stamps a queued post as published — the same row becomes the history entry. */
export function recordPost(
  id: number,
  sent: { channelId: string; channelMessageIds: number[]; mode: PostMode; postedAt: Date },
): PublishedPost {
  const row = db.update(posts).set(sent).where(eq(posts.id, id)).returning().get();
  notifyDashboard();
  return row as PublishedPost;
}

export function postedCount(): number {
  return db.select({ value: count() }).from(posts).where(published).get()?.value ?? 0;
}

export function recentPosts(limit = 10): PublishedPost[] {
  return db
    .select()
    .from(posts)
    .where(published)
    .orderBy(desc(posts.postedAt))
    .limit(limit)
    .all() as PublishedPost[];
}

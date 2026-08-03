import type { MessageEntity } from 'grammy/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single-row table (id is always 1). Everything the dashboard can configure.
 * Telegram ids are stored as text: they exceed the safe integer range for
 * channels and comparing them as strings keeps that lossless.
 */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  botToken: text('bot_token'),
  targetChannelId: text('target_channel_id'),
  delayMinutes: integer('delay_minutes').notNull().default(60),
  timezone: text('timezone').notNull().default('UTC'),
  /** While paused the scheduler skips its ticks; manual posting still works. */
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  /**
   * Appended to every post that goes to the channel — a standing sign-off like
   * "Subscribe to my awesome channel!". Null or empty means no footer.
   */
  postFooter: text('post_footer'),
  /**
   * The hours of the day posting is allowed in, as minutes since local midnight
   * in `timezone`. Null on either one means "any time"; `start > end` is a
   * window that wraps past midnight, e.g. 22:00 → 02:00.
   */
  windowStart: integer('window_start_minutes'),
  windowEnd: integer('window_end_minutes'),
  /**
   * What to do with a link whose media could not be downloaded. Off: nothing is
   * queued and the sender is told why. On: the message they sent is queued as
   * it stands, link and all, so the post is not lost.
   */
  queueRawOnFailure: integer('queue_raw_on_failure', { mode: 'boolean' })
    .notNull()
    .default(false),
  /**
   * Whether a downloaded post carries the title yt-dlp scraped and a `🔗 Source`
   * link back to where it came from. Off leaves the sender's own words alone as
   * the whole caption.
   */
  downloadMetadata: integer('download_metadata', { mode: 'boolean' }).notNull().default(true),
  /**
   * Stamp every image and video with `data/watermark.png` before it is posted.
   * The image itself lives on disk rather than in here: it is the one piece of
   * configuration measured in megabytes, and the data directory already
   * survives redeploys.
   */
  watermarkEnabled: integer('watermark_enabled', { mode: 'boolean' }).notNull().default(false),
  /**
   * Where the watermark sits, as a percentage of the room it has to move in —
   * so 0 is flush against the left/top edge, 50 is centred, and 100 is flush
   * against the right/bottom. It can never hang over an edge.
   */
  watermarkX: integer('watermark_x').notNull().default(100),
  watermarkY: integer('watermark_y').notNull().default(100),
  /** 1–100. 100 is the PNG's own alpha untouched. */
  watermarkOpacity: integer('watermark_opacity').notNull().default(100),
  /**
   * The watermark's width as a percentage of the media's width, so one setting
   * looks the same on a phone photo and on a 1080p video.
   */
  watermarkScale: integer('watermark_scale').notNull().default(20),
  /**
   * What to do with media that cannot be stamped — anything past the 20 MB a
   * bot may download. Off: queue it unwatermarked and say so. On: refuse it,
   * so nothing reaches the channel without a watermark.
   */
  watermarkRequired: integer('watermark_required', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Everyone allowed to talk to the bot. `admin` may do everything; `manager`
 * may only add posts to the queue. There can be any number of each, but the
 * app refuses to delete the last admin — that would lock the bot out.
 */
export const users = sqliteTable('users', {
  telegramId: text('telegram_id').primaryKey(),
  role: text('role').$type<Role>().notNull().default('manager'),
  /** Cached @username or first name, so the dashboard can show a name offline. */
  label: text('label'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Role = 'admin' | 'manager';

/** Channels the bot has been added to, discovered from `my_chat_member` updates. */
export const channels = sqliteTable('channels', {
  chatId: text('chat_id').primaryKey(),
  title: text('title'),
  username: text('username'),
  type: text('type').notNull().default('channel'),
  /** Telegram ChatMember status: administrator | member | left | kicked */
  status: text('status').notNull().default('member'),
  canPost: integer('can_post', { mode: 'boolean' }).notNull().default(false),
  /** Time of the most recent message seen in the channel, from any author. */
  lastPostAt: integer('last_post_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PostKind = 'single' | 'album';
export type PostMode = 'auto' | 'manual';

/**
 * Every post the bot was given, queued and published alike — one row for the
 * whole life of a post. A row starts out queued and is stamped in place when
 * it goes out, so `posted_at IS NULL` is the queue and the rest is history.
 *
 * We never re-upload media: the original message stays in the sender's chat
 * with the bot and gets `copyMessage`d to the channel when due. That is why
 * the source ids live on the row alongside the ids of the published copies.
 */
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /**
   * Where the original lives: the private chat between sender and bot. Null
   * only on rows migrated from the old history table, which never kept it.
   */
  sourceChatId: text('source_chat_id'),
  sourceMessageIds: text('source_message_ids', { mode: 'json' }).$type<number[]>(),
  kind: text('kind').$type<PostKind>().notNull().default('single'),
  /** text | photo | video | animation | document | audio | voice | sticker | poll | ... */
  contentType: text('content_type').notNull().default('text'),
  preview: text('preview').notNull().default(''),
  /**
   * The sender's own words, verbatim, and the formatting that goes with them —
   * what the footer is appended to when the post is published. `''` is a post
   * that carries no words; null is a row from before the bot kept them, whose
   * caption must be left alone because we cannot rebuild it.
   */
  sourceText: text('source_text'),
  sourceEntities: text('source_entities', { mode: 'json' }).$type<MessageEntity[]>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),

  // --- Filled in when the post is published; null while it is queued. -------
  channelId: text('channel_id'),
  channelMessageIds: text('channel_message_ids', { mode: 'json' }).$type<number[]>(),
  mode: text('mode').$type<PostMode>(),
  postedAt: integer('posted_at', { mode: 'timestamp_ms' }),
});

export type Settings = typeof settings.$inferSelect;
export type User = typeof users.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Post = typeof posts.$inferSelect;

/**
 * A post still waiting to go out. Anything the queue creates has a source, so
 * the queue helpers narrow to this and callers need no null checks.
 */
export type QueuedPost = Post & {
  sourceChatId: string;
  sourceMessageIds: number[];
  postedAt: null;
};

/** A post that has been published. */
export type PublishedPost = Post & {
  channelId: string;
  channelMessageIds: number[];
  mode: PostMode;
  postedAt: Date;
};

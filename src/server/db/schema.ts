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

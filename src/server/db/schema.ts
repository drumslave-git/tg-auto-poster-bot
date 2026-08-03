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

/**
 * A pending post. We never re-upload media: the original message stays in the
 * admin's chat with the bot and gets `copyMessage`d to the channel when due.
 */
export const queueItems = sqliteTable('queue_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceChatId: text('source_chat_id').notNull(),
  messageIds: text('message_ids', { mode: 'json' }).$type<number[]>().notNull(),
  /** single | album */
  kind: text('kind').notNull().default('single'),
  /** text | photo | video | animation | document | audio | voice | sticker | poll | ... */
  contentType: text('content_type').notNull().default('text'),
  preview: text('preview').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** History of what the bot published, for the "posted" counter and the log. */
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channelId: text('channel_id').notNull(),
  messageIds: text('message_ids', { mode: 'json' }).$type<number[]>().notNull(),
  contentType: text('content_type').notNull().default('text'),
  preview: text('preview').notNull().default(''),
  /** auto | manual */
  mode: text('mode').notNull().default('auto'),
  postedAt: integer('posted_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Settings = typeof settings.$inferSelect;
export type User = typeof users.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type QueueItem = typeof queueItems.$inferSelect;
export type Post = typeof posts.$inferSelect;

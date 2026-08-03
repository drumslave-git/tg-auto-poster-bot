import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { channels, type Channel } from '../db/schema.js';

export type ChannelUpsert = {
  chatId: string;
  title?: string | null;
  username?: string | null;
  type?: string;
  status?: string;
  canPost?: boolean;
};

export function upsertChannel(input: ChannelUpsert): void {
  const now = new Date();
  db.insert(channels)
    .values({
      chatId: input.chatId,
      title: input.title ?? null,
      username: input.username ?? null,
      type: input.type ?? 'channel',
      status: input.status ?? 'member',
      canPost: input.canPost ?? false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: channels.chatId,
      set: {
        // Only overwrite metadata we actually received in this update.
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.canPost !== undefined ? { canPost: input.canPost } : {}),
        updatedAt: now,
      },
    })
    .run();
}

/** Records channel activity — this is what the delay is measured from. */
export function touchLastPost(chatId: string, at: Date): void {
  db.update(channels).set({ lastPostAt: at }).where(eq(channels.chatId, chatId)).run();
}

export function getChannel(chatId: string): Channel | undefined {
  return db.select().from(channels).where(eq(channels.chatId, chatId)).get();
}

export function listChannels(): Channel[] {
  return db.select().from(channels).orderBy(desc(channels.updatedAt)).all();
}

/** Channels the bot can currently publish to. */
export function postableChannels(): Channel[] {
  return listChannels().filter((c) => c.status === 'administrator' || c.status === 'creator');
}

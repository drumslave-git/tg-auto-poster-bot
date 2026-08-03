import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { Role } from '../db/schema.js';
import { listUsers } from '../services/users.js';

type Command = {
  command: string;
  /** Placeholder shown in the help text, e.g. `N` for `/delay N`. */
  args?: string;
  description: string;
  /** Admin-only commands are hidden from a manager's menu and help. */
  admin?: true;
};

/**
 * The single source of truth for what the bot can be told to do: the Telegram
 * menu, the /help text and the two roles all read from this list, so a command
 * cannot be advertised in one place and missing from another.
 */
export const COMMANDS: Command[] = [
  { command: 'queue', description: 'how many posts are waiting' },
  { command: 'till', description: 'time until the next automatic post' },
  { command: 'summary', description: 'queue size, next post time, total runway' },
  { command: 'delay', args: 'N', description: 'set the delay between posts to N minutes', admin: true },
  { command: 'post', description: 'publish the next item right now', admin: true },
  { command: 'pause', description: 'stop automatic posting', admin: true },
  { command: 'resume', description: 'start automatic posting again', admin: true },
  { command: 'clear', description: 'empty the queue', admin: true },
  { command: 'help', description: 'show what I can do' },
];

/** What strangers and not-yet-configured users see before anyone knows them. */
const PUBLIC_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'what this bot does' },
  { command: 'help', description: 'show what I can do' },
];

function visibleTo(role: Role): Command[] {
  return COMMANDS.filter((entry) => role === 'admin' || !entry.admin);
}

/** The menu Telegram shows behind the ☰ button for someone with this role. */
export function menuFor(role: Role): BotCommand[] {
  return visibleTo(role).map(({ command, description }) => ({ command, description }));
}

/** The same list as /help lines: `/delay N — set the delay…`. */
export function helpLinesFor(role: Role): string[] {
  return visibleTo(role).map(
    ({ command, args, description }) => `/${command}${args ? ` ${args}` : ''} — ${description}`,
  );
}

/** Private chats we have set a per-user menu in, so stale ones can be cleared. */
const applied = new Set<string>();

/** A fresh start means Telegram's side is unknown again. */
export function forgetCommandMenus(): void {
  applied.clear();
}

/**
 * Publishes the menus. Telegram scopes commands per chat, which is how a
 * manager's menu can be shorter than an admin's: every known user gets their
 * own list, and everyone else sees only the public one.
 *
 * A user who has never opened the bot has no chat to scope to — Telegram says
 * so and we move on; the next sync picks them up once they write.
 */
export async function syncCommandMenu(api: Api): Promise<void> {
  try {
    await api.setMyCommands(PUBLIC_COMMANDS, { scope: { type: 'all_private_chats' } });
  } catch (error) {
    console.warn('[bot] could not set the default command menu:', describe(error));
  }

  const users = listUsers();
  const current = new Set(users.map((user) => user.telegramId));

  for (const telegramId of [...applied]) {
    if (current.has(telegramId)) continue;
    applied.delete(telegramId);
    await api
      .deleteMyCommands({ scope: { type: 'chat', chat_id: Number(telegramId) } })
      .catch(() => undefined);
  }

  for (const user of users) {
    try {
      await api.setMyCommands(menuFor(user.role), {
        scope: { type: 'chat', chat_id: Number(user.telegramId) },
      });
      applied.add(user.telegramId);
    } catch (error) {
      // Usually "chat not found": they are on the list but never said hello.
      console.warn(`[bot] no command menu for ${user.telegramId}: ${describe(error)}`);
    }
  }
}

/**
 * Publishes one user's menu unless it is already up. Someone added to the
 * dashboard before they ever opened the bot has no chat to scope to, so their
 * menu is set the first time they write instead.
 */
export async function ensureCommandMenu(api: Api, telegramId: string, role: Role): Promise<void> {
  if (applied.has(telegramId)) return;
  try {
    await api.setMyCommands(menuFor(role), {
      scope: { type: 'chat', chat_id: Number(telegramId) },
    });
    applied.add(telegramId);
  } catch (error) {
    console.warn(`[bot] no command menu for ${telegramId}: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

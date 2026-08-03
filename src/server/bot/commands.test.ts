import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import type { BotCommand, BotCommandScope } from 'grammy/types';
import { addUser, removeUser } from '../services/users.js';
import { resetDb } from '../test/db.js';
import {
  COMMANDS,
  ensureCommandMenu,
  forgetCommandMenus,
  helpLinesFor,
  menuFor,
  syncCommandMenu,
} from './commands.js';

type Call = { commands: string[]; chatId: number | 'all' };

/** Records what would have gone to Telegram; `fail` makes one chat unreachable. */
function fakeApi(fail?: number) {
  const set: Call[] = [];
  const deleted: number[] = [];

  const chatOf = (scope: BotCommandScope): number | 'all' =>
    scope.type === 'chat' ? Number(scope.chat_id) : 'all';

  const api = {
    setMyCommands: vi.fn(async (commands: BotCommand[], options: { scope: BotCommandScope }) => {
      const chatId = chatOf(options.scope);
      if (chatId === fail) throw new Error('Telegram API: chat not found');
      set.push({ commands: commands.map((c) => c.command), chatId });
    }),
    deleteMyCommands: vi.fn(async (options: { scope: BotCommandScope }) => {
      deleted.push(Number(chatOf(options.scope)));
    }),
  };

  return { api: api as unknown as Api, set, deleted };
}

beforeEach(() => {
  resetDb();
  forgetCommandMenus();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('menuFor', () => {
  it('gives an admin every command', () => {
    expect(menuFor('admin')).toHaveLength(COMMANDS.length);
  });

  it('hides the admin-only ones from a manager', () => {
    const manager = menuFor('manager').map((c) => c.command);

    expect(manager).toEqual(['queue', 'till', 'summary', 'help']);
    expect(manager).not.toContain('clear');
  });

  it('carries a description for every command, as Telegram requires', () => {
    for (const { command, description } of menuFor('admin')) {
      expect(description, command).toMatch(/\S/);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });
});

describe('helpLinesFor', () => {
  it('writes one line per command, with its argument', () => {
    expect(helpLinesFor('admin')).toContain('/delay N — set the delay between posts to N minutes');
    expect(helpLinesFor('manager')).toContain('/queue — how many posts are waiting');
  });

  it('stays in step with the menu', () => {
    expect(helpLinesFor('manager')).toHaveLength(menuFor('manager').length);
  });
});

describe('syncCommandMenu', () => {
  it('publishes a public menu and one per user', async () => {
    addUser('100', 'admin');
    addUser('200', 'manager');
    const { api, set } = fakeApi();

    await syncCommandMenu(api);

    expect(set.find((c) => c.chatId === 'all')?.commands).toEqual(['start', 'help']);
    expect(set.find((c) => c.chatId === 100)?.commands).toContain('clear');
    expect(set.find((c) => c.chatId === 200)?.commands).not.toContain('clear');
  });

  it('clears the menu of someone who was removed', async () => {
    addUser('100', 'admin');
    addUser('200', 'manager');
    const first = fakeApi();
    await syncCommandMenu(first.api);

    removeUser('200');
    const second = fakeApi();
    await syncCommandMenu(second.api);

    expect(second.deleted).toEqual([200]);
    expect(second.set.map((c) => c.chatId)).not.toContain(200);
  });

  it('keeps going when one user has never opened the bot', async () => {
    addUser('100', 'admin');
    addUser('200', 'manager');
    const { api, set } = fakeApi(100);

    await syncCommandMenu(api);

    expect(set.map((c) => c.chatId)).toEqual(['all', 200]);
  });
});

describe('ensureCommandMenu', () => {
  it('sets the menu the first time only', async () => {
    const { api, set } = fakeApi();

    await ensureCommandMenu(api, '100', 'admin');
    await ensureCommandMenu(api, '100', 'admin');

    expect(set.map((c) => c.chatId)).toEqual([100]);
  });

  it('retries after a chat that could not be reached', async () => {
    const failing = fakeApi(100);
    await ensureCommandMenu(failing.api, '100', 'admin');
    expect(failing.set).toHaveLength(0);

    const working = fakeApi();
    await ensureCommandMenu(working.api, '100', 'admin');
    expect(working.set.map((c) => c.chatId)).toEqual([100]);
  });

  it('does not repeat what a sync already published', async () => {
    addUser('100', 'admin');
    const { api, set } = fakeApi();
    await syncCommandMenu(api);
    set.length = 0;

    await ensureCommandMenu(api, '100', 'admin');

    expect(set).toHaveLength(0);
  });
});

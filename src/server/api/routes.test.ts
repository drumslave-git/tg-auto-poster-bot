import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './routes.js';
import { upsertChannel } from '../services/channels.js';
import { enqueue, listQueue, postedCount } from '../services/queue.js';
import { ensureSettings, getSettings } from '../services/settings.js';
import { addUser, listUsers } from '../services/users.js';
import { resetDb } from '../test/db.js';

/**
 * The bot is the one thing these routes reach the network through, so it is
 * stubbed out; everything else runs for real against the scratch database.
 */
const stub = vi.hoisted(() => {
  const stopped = { status: 'stopped' as const, error: null, info: null };
  return {
    botManager: {
      getApi: vi.fn((): unknown => null),
      getState: vi.fn(() => stopped),
      apply: vi.fn(async () => stopped),
      restart: vi.fn(async () => ({ status: 'running' as const, error: null, info: null })),
    },
  };
});

vi.mock('../bot/manager.js', () => ({ botManager: stub.botManager }));

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetDb();
  ensureSettings();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function queueItem(preview = 'hello') {
  return enqueue({
    sourceChatId: '42',
    sourceMessageIds: [1],
    kind: 'single',
    contentType: 'text',
    preview,
  });
}

describe('GET /status', () => {
  it('answers with the dashboard snapshot', async () => {
    const { status, body } = await call('GET', '/api/status');

    expect(status).toBe(200);
    expect(body).toMatchObject({ bot: { status: 'stopped' }, settings: { delayMinutes: 60 } });
  });
});

describe('PUT /settings', () => {
  it('applies a valid patch', async () => {
    const { status, body } = await call('PUT', '/api/settings', {
      delayMinutes: 15,
      timezone: 'Europe/Berlin',
      paused: true,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      settings: { delayMinutes: 15, timezone: 'Europe/Berlin', paused: true },
    });
    expect(getSettings()).toMatchObject({ delayMinutes: 15, timezone: 'Europe/Berlin', paused: true });
  });

  it('leaves absent fields untouched', async () => {
    await call('PUT', '/api/settings', { delayMinutes: 15 });

    await call('PUT', '/api/settings', { timezone: 'Europe/Berlin' });

    expect(getSettings().delayMinutes).toBe(15);
  });

  it('rejects a delay outside the allowed range', async () => {
    for (const delayMinutes of [0, 1.5, 60 * 24 * 30 + 1, 'soon']) {
      const { status, body } = await call('PUT', '/api/settings', { delayMinutes });
      expect(status).toBe(400);
      expect(body.error).toMatch(/delayMinutes/);
    }
  });

  it('rejects an unknown time zone', async () => {
    const { status, body } = await call('PUT', '/api/settings', { timezone: 'Mars/Olympus' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/time zone/);
  });

  it('rejects a non-boolean pause', async () => {
    const { status, body } = await call('PUT', '/api/settings', { paused: 'yes' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/paused/);
  });

  it('collects every complaint at once', async () => {
    const { body } = await call('PUT', '/api/settings', { delayMinutes: 0, timezone: '' });

    expect(String(body.error).split(';')).toHaveLength(2);
  });

  it('rejects something that is not a bot token', async () => {
    const { status, body } = await call('PUT', '/api/settings', { botToken: 'nope' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/botToken/);
    expect(stub.botManager.apply).not.toHaveBeenCalled();
  });

  it('restarts the bot when the token changes, and masks it in the reply', async () => {
    const botToken = '123456:AAEabcdefghijklmnopqXYZW';

    const { status, body } = await call('PUT', '/api/settings', { botToken });

    expect(status).toBe(200);
    expect(stub.botManager.apply).toHaveBeenCalledExactlyOnceWith(botToken);
    expect(body.settings).toMatchObject({ hasToken: true, tokenMask: '123456:••••••••XYZW' });
    expect(JSON.stringify(body)).not.toContain(botToken);
  });

  it('treats an empty token as "forget it"', async () => {
    await call('PUT', '/api/settings', { botToken: '123456:AAEabcdefghijklmnopqXYZW' });

    const { body } = await call('PUT', '/api/settings', { botToken: '' });

    expect(stub.botManager.apply).toHaveBeenLastCalledWith(null);
    expect(body.settings).toMatchObject({ hasToken: false, tokenMask: null });
  });

  it('clears the target channel with an empty string', async () => {
    upsertChannel({ chatId: '-1001', status: 'administrator' });
    await call('PUT', '/api/settings', { targetChannelId: '-1001' });

    await call('PUT', '/api/settings', { targetChannelId: '' });

    expect(getSettings().targetChannelId).toBeNull();
  });
});

describe('users', () => {
  it('adds one and lists it back', async () => {
    const { status, body } = await call('POST', '/api/users', { telegramId: '100', role: 'admin' });

    expect(status).toBe(200);
    expect(body.users).toMatchObject([{ telegramId: '100', role: 'admin' }]);
  });

  it('defaults a new user to manager', async () => {
    await call('POST', '/api/users', { telegramId: '100' });

    expect(listUsers()[0]?.role).toBe('manager');
  });

  it('rejects anything that is not a user id', async () => {
    for (const telegramId of ['', 'abc', '-1001', '  ']) {
      const { status, body } = await call('POST', '/api/users', { telegramId });
      expect(status).toBe(400);
      expect(body.error).toMatch(/telegramId/);
    }
  });

  it('rejects an unknown role', async () => {
    const { status, body } = await call('POST', '/api/users', { telegramId: '100', role: 'owner' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/role must be one of admin, manager/);
  });

  it('refuses to add the same person twice', async () => {
    addUser('100', 'admin');

    const { status } = await call('POST', '/api/users', { telegramId: '100' });

    expect(status).toBe(409);
  });

  it('changes a role', async () => {
    addUser('100', 'admin');
    addUser('200', 'manager');

    const { status, body } = await call('PATCH', '/api/users/200', { role: 'admin' });

    expect(status).toBe(200);
    expect(body.users).toMatchObject([{ telegramId: '100' }, { telegramId: '200', role: 'admin' }]);
  });

  it('404s on an unknown user', async () => {
    expect((await call('PATCH', '/api/users/999', { role: 'admin' })).status).toBe(404);
    expect((await call('DELETE', '/api/users/999')).status).toBe(404);
  });

  it('400s on a patch without a valid role', async () => {
    addUser('100', 'admin');

    expect((await call('PATCH', '/api/users/100', {})).status).toBe(400);
  });

  it('protects the last admin from demotion and deletion', async () => {
    addUser('100', 'admin');
    addUser('200', 'manager');

    const demote = await call('PATCH', '/api/users/100', { role: 'manager' });
    const remove = await call('DELETE', '/api/users/100');

    expect(demote.status).toBe(409);
    expect(demote.body.error).toMatch(/demote the last admin/);
    expect(remove.status).toBe(409);
    expect(remove.body.error).toMatch(/remove the last admin/);
    expect(listUsers()).toHaveLength(2);
  });

  it('removes an admin once another one exists', async () => {
    addUser('100', 'admin');
    addUser('200', 'admin');

    const { status, body } = await call('DELETE', '/api/users/100');

    expect(status).toBe(200);
    expect(body.users).toMatchObject([{ telegramId: '200' }]);
  });
});

describe('queue', () => {
  it('lists what is waiting', async () => {
    queueItem('first');
    queueItem('second');

    const { body } = await call('GET', '/api/queue');

    expect(body).toMatchObject({ count: 2 });
    expect((body.items as { preview: string }[]).map((i) => i.preview)).toEqual(['first', 'second']);
  });

  it('drops a single item', async () => {
    const item = queueItem();

    const { status, body } = await call('DELETE', `/api/queue/${item.id}`);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(listQueue()).toEqual([]);
  });

  it('404s on an item that is not queued', async () => {
    expect((await call('DELETE', '/api/queue/9999')).status).toBe(404);
  });

  it('400s on an id that is not a number', async () => {
    const { status, body } = await call('DELETE', '/api/queue/abc');

    expect(status).toBe(400);
    expect(body.error).toBe('invalid id');
  });

  it('empties the whole queue', async () => {
    queueItem();
    queueItem();

    const { body } = await call('DELETE', '/api/queue');

    expect(body).toEqual({ ok: true, removed: 2 });
    expect(listQueue()).toEqual([]);
  });
});

describe('GET /posts', () => {
  it('answers with the history', async () => {
    const { status, body } = await call('GET', '/api/posts');

    expect(status).toBe(200);
    expect(body).toEqual({ count: postedCount(), items: [] });
  });
});

describe('routes that need a running bot', () => {
  it('refuses to post now', async () => {
    const { status, body } = await call('POST', '/api/post-now');

    expect(status).toBe(409);
    expect(body.error).toBe('Bot is not running.');
  });

  it('refuses to register a channel', async () => {
    const { status, body } = await call('POST', '/api/channels', { chatId: '@news' });

    expect(status).toBe(409);
    expect(body.error).toBe('Bot is not running.');
  });

  it('wants a chatId before it even looks at the bot', async () => {
    const { status, body } = await call('POST', '/api/channels', {});

    expect(status).toBe(400);
    expect(body.error).toBe('chatId is required');
  });

  it('restarts the bot', async () => {
    const { status, body } = await call('POST', '/api/bot/restart');

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, bot: { status: 'running' } });
    expect(stub.botManager.restart).toHaveBeenCalledOnce();
  });
});

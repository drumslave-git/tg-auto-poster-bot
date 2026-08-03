import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './routes.js';
import { MAX_WATERMARK_IMAGE_BYTES } from '../media/watermark.js';
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

  it('stores the footer and trims it', async () => {
    const { body } = await call('PUT', '/api/settings', { postFooter: '  Subscribe!  ' });

    expect(body.settings).toMatchObject({ postFooter: 'Subscribe!' });
    expect(getSettings().postFooter).toBe('Subscribe!');
  });

  it('clears the footer when it is emptied', async () => {
    await call('PUT', '/api/settings', { postFooter: 'Subscribe!' });

    const { body } = await call('PUT', '/api/settings', { postFooter: '   ' });

    expect(body.settings).toMatchObject({ postFooter: '' });
    expect(getSettings().postFooter).toBeNull();
  });

  it('rejects a footer longer than a caption can spare', async () => {
    const { status, body } = await call('PUT', '/api/settings', { postFooter: 'x'.repeat(401) });

    expect(status).toBe(400);
    expect(body.error).toMatch(/postFooter/);
  });

  it('stores the posting window as clock times', async () => {
    const { body } = await call('PUT', '/api/settings', {
      windowStart: '13:00',
      windowEnd: '17:30',
    });

    expect(body.settings).toMatchObject({ windowStart: '13:00', windowEnd: '17:30' });
    expect(getSettings()).toMatchObject({ windowStart: 13 * 60, windowEnd: 17 * 60 + 30 });
  });

  it('clears the window when both ends are emptied', async () => {
    await call('PUT', '/api/settings', { windowStart: '13:00', windowEnd: '17:00' });

    const { body } = await call('PUT', '/api/settings', { windowStart: '', windowEnd: '' });

    expect(body.settings).toMatchObject({ windowStart: null, windowEnd: null });
    expect(getSettings()).toMatchObject({ windowStart: null, windowEnd: null });
  });

  it('rejects a window that is not a time of day', async () => {
    const { status, body } = await call('PUT', '/api/settings', {
      windowStart: '25:00',
      windowEnd: '17:00',
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/windowStart/);
  });

  it('refuses half a window', async () => {
    const { status, body } = await call('PUT', '/api/settings', { windowStart: '13:00' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/both/);
  });

  it('refuses a window with no width', async () => {
    const { status, body } = await call('PUT', '/api/settings', {
      windowStart: '13:00',
      windowEnd: '13:00',
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/differ/);
  });

  it('rejects a non-boolean pause', async () => {
    const { status, body } = await call('PUT', '/api/settings', { paused: 'yes' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/paused/);
  });

  it('toggles the download switches', async () => {
    const { body } = await call('PUT', '/api/settings', {
      queueRawOnFailure: true,
      downloadMetadata: false,
    });

    expect(body.settings).toMatchObject({ queueRawOnFailure: true, downloadMetadata: false });
    expect(getSettings()).toMatchObject({ queueRawOnFailure: true, downloadMetadata: false });
  });

  it('rejects a non-boolean download switch', async () => {
    for (const key of ['queueRawOnFailure', 'downloadMetadata']) {
      const { status, body } = await call('PUT', '/api/settings', { [key]: 'yes' });
      expect(status).toBe(400);
      expect(body.error).toMatch(new RegExp(key));
    }
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

  it('saves the watermark placement', async () => {
    const { body } = await call('PUT', '/api/settings', {
      watermarkEnabled: true,
      watermarkRequired: true,
      watermarkX: 0,
      watermarkY: 50,
      watermarkOpacity: 40,
      watermarkScale: 25,
    });

    expect(body.settings).toMatchObject({
      watermark: { enabled: true, required: true, x: 0, y: 50, opacity: 40, scale: 25 },
    });
    expect(getSettings()).toMatchObject({
      watermarkEnabled: true,
      watermarkX: 0,
      watermarkY: 50,
      watermarkOpacity: 40,
      watermarkScale: 25,
    });
  });

  it.each([
    ['watermarkX', 101],
    ['watermarkY', -1],
    // Zero opacity is an invisible watermark, which is what the switch is for.
    ['watermarkOpacity', 0],
    ['watermarkScale', 0],
    ['watermarkScale', 12.5],
  ])('rejects %s of %s', async (key, value) => {
    const { status, body } = await call('PUT', '/api/settings', { [key]: value });

    expect(status).toBe(400);
    expect(body.error).toMatch(new RegExp(key));
  });
});

describe('watermark image', () => {
  /** A PNG signature is all the server inspects, so this is a valid upload. */
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('pretend pixels'),
  ]);

  async function upload(bytes: Buffer) {
    const response = await fetch(`${base}/api/watermark`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // The watermark is a file, not a row, so resetting the database does not
  // clear it — each test has to start with none of its own accord.
  beforeEach(async () => {
    await call('DELETE', '/api/watermark');
  });

  it('has none to begin with', async () => {
    const { status } = await call('GET', '/api/watermark');

    expect(status).toBe(404);
    expect((await call('GET', '/api/status')).body).toMatchObject({
      settings: { watermark: { hasImage: false } },
    });
  });

  it('stores a PNG and serves it back byte for byte', async () => {
    expect(await upload(png)).toMatchObject({ status: 200, body: { ok: true, bytes: png.length } });

    const response = await fetch(`${base}/api/watermark`);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it('tells the dashboard it now has one', async () => {
    await upload(png);

    expect((await call('GET', '/api/status')).body).toMatchObject({
      settings: { watermark: { hasImage: true } },
    });
  });

  it('carries a stamp the preview can watch, so a replacement is noticed', async () => {
    const stamp = async () => {
      const { body } = await call('GET', '/api/status');
      const settings = body.settings as { watermark: { imageStamp: number | null } };
      return settings.watermark.imageStamp;
    };

    expect(await stamp()).toBeNull();
    await upload(png);
    expect(typeof (await stamp())).toBe('number');

    await call('DELETE', '/api/watermark');
    expect(await stamp()).toBeNull();
  });

  it('refuses anything that is not a PNG', async () => {
    const { status, body } = await upload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));

    expect(status).toBe(400);
    expect(body.error).toMatch(/PNG/);
  });

  it('refuses an empty upload', async () => {
    expect(await upload(Buffer.alloc(0))).toMatchObject({ status: 400 });
  });

  it('refuses a PNG past the size ceiling with something readable', async () => {
    const huge = Buffer.concat([png, Buffer.alloc(MAX_WATERMARK_IMAGE_BYTES)]);
    const { status, body } = await upload(huge);

    expect(status).toBe(400);
    expect(body.error).toMatch(/at most/i);
  });

  it('removes the stored one, and says so only the first time', async () => {
    await upload(png);

    expect(await call('DELETE', '/api/watermark')).toMatchObject({ status: 200 });
    expect(await call('DELETE', '/api/watermark')).toMatchObject({ status: 404 });
    expect(await call('GET', '/api/watermark')).toMatchObject({ status: 404 });
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

import { Bot, InputFile } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queueCount } from '../services/queue.js';
import { ensureSettings, updateSettings } from '../services/settings.js';
import { addUser } from '../services/users.js';
import { resetDb } from '../test/db.js';

/**
 * The two things this path reaches the outside world through: yt-dlp and
 * ffmpeg. Everything between them — the handler, the settings, the queue — is
 * the real thing running against the scratch database.
 */
const stub = vi.hoisted(() => ({
  downloadMedia: vi.fn(),
  stampFile: vi.fn(),
}));

vi.mock('./download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./download.js')>()),
  downloadMedia: stub.downloadMedia,
}));

vi.mock('../media/watermark.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/watermark.js')>()),
  stampFile: stub.stampFile,
}));

const { registerHandlers } = await import('./handlers.js');

const DOWNLOADED = '/tmp/download/media.mp4';
const STAMPED = '/tmp/stamped/out.mp4';

const cleanup = vi.fn(async () => undefined);

function downloadResult() {
  return {
    ok: true as const,
    cleanup,
    download: {
      file: DOWNLOADED,
      bytes: 4_000_000,
      kind: 'video' as const,
      title: 'A clip',
      duration: 5,
      width: 640,
      height: 360,
    },
  };
}

type Call = { method: string; payload: Record<string, unknown> };

/** A bot whose every API call is answered locally and recorded. */
function makeBot(): { bot: Bot; calls: Call[] } {
  const calls: Call[] = [];
  const bot = new Bot('123456:TEST', {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'testbot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    } as never,
  });

  registerHandlers(bot);

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    // Anything that sends a message has to come back as one, because the reply
    // is what gets queued.
    const sent = { message_id: calls.length + 100, date: 0, chat: { id: 42, type: 'private' } };
    return { ok: true, result: method.startsWith('send') ? sent : true } as never;
  });

  return { bot, calls };
}

/** A private message holding nothing but a link. */
function linkUpdate(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Sender' },
      text: 'https://example.com/clip',
      entities: [{ type: 'url', offset: 0, length: 24 }],
    },
  } as Update;
}

/** Everything the bot said in the chat. InputFile refuses to be stringified. */
function saidInChat(calls: Call[]): string {
  return calls
    .filter((call) => call.method === 'sendMessage')
    .map((call) => String(call.payload.text ?? ''))
    .join('\n');
}

/** The local path inside whatever InputFile the handler handed to Telegram. */
function sentFile(calls: Call[], method: string): string | undefined {
  const call = calls.find((entry) => entry.method === method);
  const file = call?.payload.video ?? call?.payload.photo ?? call?.payload.animation;
  // `fileData` is private on InputFile, so the path it was built from has to be
  // read around the type rather than through it.
  return file instanceof InputFile
    ? (file as unknown as { fileData: string }).fileData
    : undefined;
}

beforeEach(() => {
  resetDb();
  ensureSettings();
  addUser('7', 'admin');
  stub.downloadMedia.mockResolvedValue(downloadResult());
  stub.stampFile.mockResolvedValue({
    ok: true,
    file: STAMPED,
    bytes: 3_000_000,
    cleanup: vi.fn(async () => undefined),
  });
});

describe('media downloaded from a link', () => {
  it('is watermarked before it is sent on, and it is the stamped copy that is queued', async () => {
    updateSettings({ watermarkEnabled: true });
    const { bot, calls } = makeBot();

    await bot.handleUpdate(linkUpdate());

    // The file yt-dlp produced is what ffmpeg was pointed at...
    expect(stub.stampFile).toHaveBeenCalledWith(DOWNLOADED, 'video', expect.anything());
    // ...and the stamped result is what actually went to Telegram.
    expect(sentFile(calls, 'sendVideo')).toBe(STAMPED);
    expect(queueCount()).toBe(1);
  });

  it('is never held to the 20 MB a bot may download, because it never came from Telegram', async () => {
    updateSettings({ watermarkEnabled: true });
    // Comfortably past getFile's ceiling, and still under the upload limit.
    stub.downloadMedia.mockResolvedValue({
      ...downloadResult(),
      download: { ...downloadResult().download, bytes: 45 * 1024 * 1024 },
    });
    const { bot, calls } = makeBot();

    await bot.handleUpdate(linkUpdate());

    expect(stub.stampFile).toHaveBeenCalledOnce();
    expect(sentFile(calls, 'sendVideo')).toBe(STAMPED);
  });

  it('goes out untouched while watermarking is switched off', async () => {
    const { bot, calls } = makeBot();

    await bot.handleUpdate(linkUpdate());

    expect(stub.stampFile).not.toHaveBeenCalled();
    expect(sentFile(calls, 'sendVideo')).toBe(DOWNLOADED);
    expect(queueCount()).toBe(1);
  });

  it('is still posted, unstamped, when ffmpeg fails and the watermark is optional', async () => {
    updateSettings({ watermarkEnabled: true, watermarkRequired: false });
    stub.stampFile.mockResolvedValue({ ok: false, error: 'ffmpeg fell over' });
    const { bot, calls } = makeBot();

    await bot.handleUpdate(linkUpdate());

    expect(sentFile(calls, 'sendVideo')).toBe(DOWNLOADED);
    expect(queueCount()).toBe(1);
    expect(saidInChat(calls)).toContain('ffmpeg fell over');
  });

  it('is dropped rather than posted bare when the watermark is required', async () => {
    updateSettings({ watermarkEnabled: true, watermarkRequired: true });
    stub.stampFile.mockResolvedValue({ ok: false, error: 'ffmpeg fell over' });
    const { bot, calls } = makeBot();

    await bot.handleUpdate(linkUpdate());

    expect(calls.some((call) => call.method === 'sendVideo')).toBe(false);
    expect(queueCount()).toBe(0);
    expect(saidInChat(calls)).toContain('Nothing queued');
    // The download it gave up on still has to be swept off the disk.
    expect(cleanup).toHaveBeenCalled();
  });

  it('leaves an audio-only download alone — there is no picture to stamp', async () => {
    updateSettings({ watermarkEnabled: true });
    stub.downloadMedia.mockResolvedValue({
      ...downloadResult(),
      download: { ...downloadResult().download, file: '/tmp/download/track.mp3', kind: 'audio' },
    });
    const { bot } = makeBot();

    await bot.handleUpdate(linkUpdate());

    expect(stub.stampFile).not.toHaveBeenCalled();
    expect(queueCount()).toBe(1);
  });
});

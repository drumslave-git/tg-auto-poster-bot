import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Api, InputFile, InputMediaBuilder } from 'grammy';
import type { InputMediaPhoto, InputMediaVideo, Message, MessageEntity } from 'grammy/types';
import { MAX_STAMPABLE_BYTES, type StampKind, stampFile } from '../media/watermark.js';
import { sendableEntities } from '../services/poster.js';
import { getSettings, type WatermarkPlacement, watermarkPlacement } from '../services/settings.js';
import { formatBytes } from '../util/format.js';

/**
 * The picture inside a message, when there is one this feature can stamp.
 *
 * Photos, videos and GIFs are what "every image or video" means in practice.
 * A round video note is not really a post, and a picture sent as a file is a
 * file — stamping that would mean re-sending it as a photo, which is a bigger
 * change to someone's post than adding a watermark.
 */
export type Stampable = {
  fileId: string;
  kind: StampKind;
  /** Telegram's own figure, when it gave one. */
  bytes: number | null;
};

export function stampableMedia(message: Message): Stampable | null {
  // Photos arrive as a ladder of sizes, largest last — that is the one the
  // channel would have got, so that is the one to stamp.
  const photo = message.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, kind: 'photo', bytes: photo.file_size ?? null };

  if (message.video) {
    return { fileId: message.video.file_id, kind: 'video', bytes: message.video.file_size ?? null };
  }
  if (message.animation) {
    return {
      fileId: message.animation.file_id,
      kind: 'animation',
      bytes: message.animation.file_size ?? null,
    };
  }
  return null;
}

// --- Getting the bytes ------------------------------------------------------

/** Telegram builds these itself, but it still ends up in a filesystem path. */
export function safeName(filePath: string): string {
  return path.basename(filePath).replace(/[^\w.-]/g, '') || 'media';
}

type Fetched = { ok: true; file: string } | { ok: false; error: string };

/**
 * Pulls a file out of Telegram and onto disk. The Bot API serves files from a
 * URL with the token embedded in it, which is why this needs the token itself
 * and not just the `Api` handle.
 */
async function fetchTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  dir: string,
): Promise<Fetched> {
  try {
    // The usual failure here is "file is too big", for anything past the 20 MB
    // a bot is allowed to download.
    const { file_path: filePath } = await api.getFile(fileId);
    if (!filePath) return { ok: false, error: 'Telegram gave no path for that file.' };

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!response.ok) {
      return { ok: false, error: `Telegram refused the download (${response.status}).` };
    }

    const target = path.join(dir, safeName(filePath));
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    return { ok: true, file: target };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Stamping ---------------------------------------------------------------

/** A stamped file waiting to be sent, and the message it was made from. */
type StampedItem = {
  source: Message;
  media: Stampable;
  file: string;
  /** Removes the temporary directory this file lives in. */
  cleanup: () => Promise<void>;
};

async function stampOne(
  api: Api,
  token: string,
  message: Message,
  media: Stampable,
  placement: WatermarkPlacement,
  dir: string,
): Promise<{ ok: true; item: StampedItem } | { ok: false; error: string }> {
  if (media.bytes !== null && media.bytes > MAX_STAMPABLE_BYTES) {
    return {
      ok: false,
      error:
        `The file is ${formatBytes(media.bytes)}, and a bot may only download ` +
        `${formatBytes(MAX_STAMPABLE_BYTES)} — there is no way to reach the picture.`,
    };
  }

  const fetched = await fetchTelegramFile(api, token, media.fileId, dir);
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const stamped = await stampFile(fetched.file, media.kind, placement);
  if (!stamped.ok) return { ok: false, error: stamped.error };

  return {
    ok: true,
    item: { source: message, media, file: stamped.file, cleanup: stamped.cleanup },
  };
}

// --- Sending the stamped copies back ----------------------------------------

type ReplyTo = { reply_parameters: { message_id: number; allow_sending_without_reply: true } };

function replyTo(message: Message): ReplyTo {
  return {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
}

/** The words that came with the original, so the post keeps its caption. */
function captionOf(message: Message): { caption?: string; caption_entities?: MessageEntity[] } {
  if (!message.caption) return {};
  return {
    caption: message.caption,
    caption_entities: sendableEntities(message.caption_entities ?? []),
  };
}

async function sendStampedSingle(
  api: Api,
  chatId: number | string,
  item: StampedItem,
): Promise<Message> {
  const file = new InputFile(item.file);
  const options = { ...captionOf(item.source), ...replyTo(item.source) };

  switch (item.media.kind) {
    case 'video': {
      const { width, height, duration } = item.source.video ?? {};
      return api.sendVideo(chatId, file, {
        ...options,
        supports_streaming: true,
        ...(duration ? { duration } : {}),
        ...(width && height ? { width, height } : {}),
      });
    }
    case 'animation':
      return api.sendAnimation(chatId, file, options);
    default:
      return api.sendPhoto(chatId, file, options);
  }
}

function sendStampedAlbum(
  api: Api,
  chatId: number | string,
  items: StampedItem[],
): Promise<Message[]> {
  const media = items.map((item): InputMediaPhoto | InputMediaVideo => {
    const file = new InputFile(item.file);
    const caption = captionOf(item.source);
    return item.media.kind === 'photo'
      ? InputMediaBuilder.photo(file, caption)
      : InputMediaBuilder.video(file, caption);
  });

  return api.sendMediaGroup(chatId, media, replyTo(items[0]!.source));
}

// --- What the handlers call -------------------------------------------------

export type StampOutcome =
  /** Queue these instead of the originals. */
  | { status: 'stamped'; messages: Message[] }
  /** Nothing to do — watermarking is off, or this post holds no picture. */
  | { status: 'untouched' }
  /** It could not be stamped; `required` says whether the post is lost. */
  | { status: 'failed'; error: string; required: boolean };

/**
 * The watermark goes on at ingest, not at posting time.
 *
 * Publishing is a `copyMessage` of the message sitting in the sender's own
 * chat, so the bytes never pass through this app when a post goes out — and
 * forcing them to would put a download, a re-encode and an upload between the
 * scheduler and its deadline, with every failure landing on the queue head
 * once a minute. Stamping on the way in instead keeps the queue a queue of
 * messages to copy, does the work while the sender is still there to be told
 * how it went, and gets a link download stamped almost for free, because that
 * file is already on disk.
 */
export async function stampForQueue(api: Api, messages: Message[]): Promise<StampOutcome> {
  const settings = getSettings();
  if (!settings.watermarkEnabled) return { status: 'untouched' };

  const media = messages.map(stampableMedia);

  if (media.some((entry) => entry === null)) {
    // Nothing here is a picture: a text post, a sticker, a poll, a file.
    if (media.every((entry) => entry === null)) return { status: 'untouched' };
    // A mixed album — a photo next to a document, say. Re-sending it would
    // mean re-uploading the parts that cannot be stamped as well, and a
    // half-stamped album is worse than saying so plainly.
    return {
      status: 'failed',
      error: 'Only part of that album is an image or a video, so none of it was stamped.',
      required: settings.watermarkRequired,
    };
  }

  const token = settings.botToken;
  if (!token) return { status: 'untouched' };

  const placement = watermarkPlacement(settings);
  const chatId = messages[0]!.chat.id;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-poster-stamp-'));
  const items: StampedItem[] = [];

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    for (const item of items) await item.cleanup().catch(() => undefined);
  };

  try {
    for (const [index, message] of messages.entries()) {
      const result = await stampOne(api, token, message, media[index]!, placement, dir);
      if (!result.ok) {
        return { status: 'failed', error: result.error, required: settings.watermarkRequired };
      }
      items.push(result.item);
    }

    const sent =
      items.length > 1
        ? await sendStampedAlbum(api, chatId, items)
        : [await sendStampedSingle(api, chatId, items[0]!)];

    return { status: 'stamped', messages: sent };
  } catch (error) {
    return {
      status: 'failed',
      error: `The watermarked copy could not be sent back: ${
        error instanceof Error ? error.message : String(error)
      }`,
      required: settings.watermarkRequired,
    };
  } finally {
    await cleanup();
  }
}

export type StampedDownload =
  | { ok: true; file: string; cleanup: () => Promise<void> }
  | { ok: false; error: string; required: boolean };

/**
 * The same job for a file already on disk — a link download, which never has to
 * be fetched back out of Telegram and so is not held to the 20 MB the Bot API
 * would allow. Null means there is nothing to do and the original file stands.
 */
export async function stampDownloadedFile(
  file: string,
  kind: StampKind | null,
): Promise<StampedDownload | null> {
  const settings = getSettings();
  if (!settings.watermarkEnabled || !kind) return null;

  const stamped = await stampFile(file, kind, watermarkPlacement(settings));
  return stamped.ok
    ? { ok: true, file: stamped.file, cleanup: stamped.cleanup }
    : { ok: false, error: stamped.error, required: settings.watermarkRequired };
}

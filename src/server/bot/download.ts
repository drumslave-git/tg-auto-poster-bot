import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Message } from 'grammy/types';
import { YT_DLP, exclusiveYtDlp, summarizeYtDlpError } from '../services/tools.js';
import { type CommandResult, runCommand } from '../util/exec.js';
import { formatBytes } from '../util/format.js';
import { privateHostReason } from '../util/network.js';
import { detectContentType } from './capture.js';

/**
 * Telegram lets a bot upload at most 50 MB, so that is also the ceiling for a
 * download: anything larger could never be sent on to the channel.
 */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Room kept aside for the audio stream when video and audio are downloaded
 * separately and merged.
 *
 * Each stream is filtered on its own, so a video picked right up against the
 * ceiling would produce a merged file over it. Audio is a rounding error next
 * to video — a few MB for anything short enough to send at all — so spending a
 * little of the budget up front is cheaper than downloading and then refusing.
 */
const AUDIO_BUDGET_BYTES = 6 * 1024 * 1024;

/** Generous enough for 50 MB on a slow line, short enough not to hang a queue. */
const TIMEOUT_MS = 5 * 60_000;

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

/** Sentence punctuation that ends up glued to a link written inline in prose. */
const TRAILING_JUNK = /[.,;:!?)\]}'"»]+$/;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A link we are willing to hand to yt-dlp, in canonical form, or null.
 *
 * Everything here is untrusted: a `text_link` entity carries whatever URL the
 * sender chose, and Telegram marks bare domains as links too. Only http(s)
 * survives — `file:`, `tg:` and friends are not media links and have no
 * business reaching a downloader.
 */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(TRAILING_JUNK, '');
  if (!trimmed) return null;

  try {
    // A bare `example.com/clip` is a link as far as Telegram is concerned.
    const parsed = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * The link to download from, or null when this message is not just a link.
 *
 * Only text-only messages qualify. A photo or video with a link in its caption
 * already *is* the post, so it goes to the queue untouched.
 */
export function extractDownloadUrl(message: Message): string | null {
  if (detectContentType(message) !== 'text') return null;
  const text = message.text;
  if (!text) return null;

  // Telegram has already found the links for us; offsets are UTF-16, same as
  // JavaScript string indices.
  const entities = (message.entities ?? [])
    .filter((entity) => entity.type === 'url' || entity.type === 'text_link')
    .sort((a, b) => a.offset - b.offset);

  const first = entities[0];
  if (first) {
    return normalizeUrl(
      first.type === 'text_link'
        ? first.url
        : text.slice(first.offset, first.offset + first.length),
    );
  }

  // Clients that send no entities (and plain API callers) still get a link.
  const match = URL_PATTERN.exec(text);
  return match ? normalizeUrl(match[0]) : null;
}

export type MediaKind = 'video' | 'animation' | 'audio' | 'photo' | 'document';

const KIND_BY_EXTENSION: Record<string, MediaKind> = {
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  gif: 'animation',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  opus: 'audio',
  oga: 'audio',
  ogg: 'audio',
  wav: 'audio',
  jpg: 'photo',
  jpeg: 'photo',
  png: 'photo',
  webp: 'photo',
};

/** How to send the file, so Telegram plays it inline instead of attaching it. */
export function mediaKindFor(file: string): MediaKind {
  const extension = path.extname(file).slice(1).toLowerCase();
  return KIND_BY_EXTENSION[extension] ?? 'document';
}

/**
 * One line of metadata is printed on stdout alongside yt-dlp's normal chatter,
 * so the fields are joined with the ASCII unit separator — a character no title
 * contains — and the line is found by looking for it.
 */
export const FIELD_SEPARATOR = String.fromCharCode(31);

const METADATA_FIELDS = ['title', 'duration', 'width', 'height'] as const;

export type Metadata = {
  title: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
};

/** yt-dlp prints `NA` for fields the site does not provide. */
function textField(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed && trimmed !== 'NA' ? trimmed : null;
}

function numberField(value: string | undefined): number | null {
  const text = textField(value);
  if (!text) return null;
  const parsed = Math.round(Number(text));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseMetadata(stdout: string): Metadata {
  const line = stdout
    .split('\n')
    .reverse()
    .find((candidate) => candidate.includes(FIELD_SEPARATOR));
  const [title, duration, width, height] = (line ?? '').split(FIELD_SEPARATOR);

  return {
    title: textField(title),
    duration: numberField(duration),
    width: numberField(width),
    height: numberField(height),
  };
}

export function buildYtDlpArgs(url: string, outputTemplate: string): string[] {
  const limit = String(MAX_DOWNLOAD_BYTES);
  const videoLimit = String(MAX_DOWNLOAD_BYTES - AUDIO_BUDGET_BYTES);

  return [
    // A link to a video inside a playlist means that video, not the playlist…
    '--no-playlist',
    // …and a link to a playlist or a channel still means one post, not a
    // hundred downloads.
    '--playlist-items',
    '1',
    '--no-progress',
    '--no-part',
    '--no-mtime',
    // --print implies --quiet; we want the ordinary messages for error details.
    '--no-quiet',
    '--no-simulate',
    '--socket-timeout',
    '30',
    '--retries',
    '3',
    // Skips a stream whose advertised size is over the limit before spending
    // any bandwidth on it. The file on disk is measured again afterwards,
    // because plenty of sites report no size at all. Plain bytes, no unit:
    // --max-filesize rejects a `B` suffix, and reads a bare `M` as 10⁶.
    '--max-filesize',
    limit,
    // Video and audio as separate streams first. Sites that serve DASH — most
    // of YouTube — offer only a low-resolution muxed file, so asking for one
    // ready-made file first would quietly settle for 360p while the 1080p
    // streams fit the budget with room to spare. `?` goes right after the
    // operator and keeps formats whose size the site does not report, which
    // would otherwise all be filtered out.
    '-f',
    `bv*[filesize<=?${videoLimit}]+ba/b[filesize<=?${limit}]/b`,
    // 1080p h264 in an mp4 is what Telegram plays inline everywhere; `res:1080`
    // prefers the largest format no larger than that. Audio is spelled out too:
    // left to itself yt-dlp ranks opus above aac, which does not go into an mp4
    // and drops the merge into an mkv Telegram will not play inline.
    '-S',
    'res:1080,vcodec:h264,acodec:aac',
    '--merge-output-format',
    'mp4',
    '--print',
    `after_move:${METADATA_FIELDS.map((field) => `%(${field})s`).join(FIELD_SEPARATOR)}`,
    '-o',
    outputTemplate,
    '--',
    url,
  ];
}

/** True when yt-dlp refused the media for being over --max-filesize. */
export function mentionsSizeLimit(output: string): boolean {
  return /larger than max-filesize/i.test(output);
}

/** The biggest file in the directory — after a merge only one is left anyway. */
async function largestFile(dir: string): Promise<{ file: string; bytes: number } | null> {
  const names = await readdir(dir);
  let best: { file: string; bytes: number } | null = null;

  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    if (!best || info.size > best.bytes) best = { file, bytes: info.size };
  }

  return best;
}

export type Download = Metadata & {
  /** Absolute path inside a temporary directory that `cleanup` removes. */
  file: string;
  kind: MediaKind;
  bytes: number;
};

export type DownloadResult =
  | { ok: true; download: Download; cleanup: () => Promise<void> }
  | { ok: false; error: string };

/** Never overlaps another download, nor the updater replacing yt-dlp itself. */
export function downloadMedia(url: string): Promise<DownloadResult> {
  return exclusiveYtDlp(() => downloadNow(url));
}

async function downloadNow(url: string): Promise<DownloadResult> {
  // Checked before anything is spent on it: the host, not just the scheme.
  const blocked = await privateHostReason(url);
  if (blocked) return { ok: false, error: blocked };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-poster-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fail = async (error: string): Promise<DownloadResult> => {
    await cleanup().catch(() => undefined);
    return { ok: false, error };
  };

  const result: CommandResult = await runCommand(
    YT_DLP,
    buildYtDlpArgs(url, path.join(dir, 'media.%(ext)s')),
    { timeoutMs: TIMEOUT_MS },
  );

  if (result.spawnError) {
    return fail(
      result.spawnError.code === 'ENOENT'
        ? 'yt-dlp is not installed on the server — the dashboard shows the media tools.'
        : `Could not run yt-dlp: ${result.spawnError.message}`,
    );
  }

  if (result.timedOut) {
    return fail(`The download did not finish within ${TIMEOUT_MS / 60_000} minutes.`);
  }

  // A file that arrived counts, even if yt-dlp then grumbled about something.
  const found = await largestFile(dir);
  if (!found) {
    if (mentionsSizeLimit(result.output)) {
      return fail(`The media is larger than the ${formatBytes(MAX_DOWNLOAD_BYTES)} a bot may upload.`);
    }
    return fail(
      summarizeYtDlpError(result.output) ??
        `yt-dlp downloaded nothing — the link may hold no media, or more than ${formatBytes(MAX_DOWNLOAD_BYTES)} of it.`,
    );
  }

  if (found.bytes > MAX_DOWNLOAD_BYTES) {
    return fail(
      `The media is ${formatBytes(found.bytes)}, over the ${formatBytes(MAX_DOWNLOAD_BYTES)} a bot may upload.`,
    );
  }

  return {
    ok: true,
    cleanup,
    download: {
      file: found.file,
      bytes: found.bytes,
      kind: mediaKindFor(found.file),
      ...parseMetadata(result.stdout),
    },
  };
}

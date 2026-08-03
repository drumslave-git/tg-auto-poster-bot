import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../env.js';
import { FFMPEG, FFPROBE } from '../services/tools.js';
import type { WatermarkPlacement } from '../services/settings.js';
import { runCommand } from '../util/exec.js';
import { formatBytes } from '../util/format.js';

/**
 * Telegram's two ceilings, which between them bracket this whole feature: a bot
 * may download 20 MB through getFile and upload 50 MB. Media past the first
 * cannot be fetched to be stamped at all — the bytes are simply out of reach —
 * and a stamped file past the second could never be sent on to the channel.
 */
export const MAX_STAMPABLE_BYTES = 20 * 1024 * 1024;
export const MAX_SENDABLE_BYTES = 50 * 1024 * 1024;

/** A logo, not a wallpaper: 2 MB is generous for a PNG with an alpha channel. */
export const MAX_WATERMARK_IMAGE_BYTES = 2 * 1024 * 1024;

/** Long enough for a 20 MB video on a small host, short enough not to hang. */
const TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * One re-encode at a time. An album arrives as several messages at once and a
 * busy chat can queue up more, but the container this runs in is sized for a
 * single ffmpeg — several 1080p encodes in parallel is how a 512 MB host gets
 * itself OOM-killed. Waiting is invisible next to the upload that follows.
 */
let encodeQueue: Promise<unknown> = Promise.resolve();

function exclusiveEncode<T>(task: () => Promise<T>): Promise<T> {
  const result = encodeQueue.then(task, task);
  encodeQueue = result.catch(() => undefined);
  return result;
}

/**
 * Below this the overlay is a smudge, and a scale small enough to round the
 * height to zero makes ffmpeg refuse the filter outright.
 */
const MIN_OVERLAY_WIDTH = 8;

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- The watermark image ----------------------------------------------------

/** Why this upload is not a usable watermark, or null when it is one. */
export function watermarkImageProblem(bytes: Buffer): string | null {
  if (bytes.length === 0) return 'The file is empty.';
  if (bytes.length > MAX_WATERMARK_IMAGE_BYTES) {
    return `The watermark must be at most ${formatBytes(MAX_WATERMARK_IMAGE_BYTES)}.`;
  }
  // Only PNG: it is the one common format that carries transparency, and a
  // watermark without an alpha channel is a rectangle pasted over the picture.
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'The watermark must be a PNG file.';
  }
  return null;
}

export function hasWatermarkImage(): boolean {
  return existsSync(env.watermarkPath);
}

/**
 * When the stored watermark last changed. The dashboard keys its preview on
 * this: replacing the PNG leaves `hasImage` true, so without something that
 * moves, the old image would stay on screen.
 */
export function watermarkImageStamp(): number | null {
  try {
    return statSync(env.watermarkPath).mtimeMs;
  } catch {
    return null;
  }
}

export function readWatermarkImage(): Promise<Buffer> {
  return readFile(env.watermarkPath);
}

export async function saveWatermarkImage(bytes: Buffer): Promise<void> {
  await writeFile(env.watermarkPath, bytes);
}

export async function removeWatermarkImage(): Promise<boolean> {
  if (!hasWatermarkImage()) return false;
  await rm(env.watermarkPath, { force: true });
  return true;
}

// --- Geometry ---------------------------------------------------------------

export type Size = { width: number; height: number };

/** Where the watermark lands, in pixels, on media of a given size. */
export type Geometry = Size & { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The watermark's size and position in pixels.
 *
 * Width comes from `scale` as a share of the media's own width, so one setting
 * suits a phone photo and a 1080p video alike, and the height follows from the
 * PNG's aspect ratio. Anything that still would not fit is shrunk until it
 * does — the overlay is never allowed to be larger than what it sits on.
 *
 * Position is then a percentage of the room that is left over: 0 puts the
 * watermark flush against the left (or top) edge, 50 centres it, 100 puts it
 * flush against the right (or bottom). Because the travel is `media - overlay`
 * rather than the full width, no setting can push it over an edge — 100/100 is
 * the bottom-right corner with the whole watermark still on the picture.
 */
export function overlayGeometry(
  placement: WatermarkPlacement,
  media: Size,
  image: Size,
): Geometry {
  let width = clamp(
    Math.round((media.width * placement.scale) / 100),
    Math.min(MIN_OVERLAY_WIDTH, media.width),
    media.width,
  );
  let height = Math.max(1, Math.round((width * image.height) / image.width));

  // A wide setting on a tall logo can still overflow vertically; height is the
  // binding constraint then, and the width follows it back down.
  if (height > media.height) {
    height = media.height;
    width = clamp(Math.round((height * image.width) / image.height), 1, media.width);
  }

  return {
    width,
    height,
    x: Math.round(((media.width - width) * clamp(placement.x, 0, 100)) / 100),
    y: Math.round(((media.height - height) * clamp(placement.y, 0, 100)) / 100),
  };
}

/**
 * The filter graph that draws the watermark on. `[1:v]` is the PNG: it is given
 * an alpha channel it may already have, dimmed to the configured opacity —
 * `colorchannelmixer` scales the alpha it finds rather than replacing it, so a
 * logo's own transparent margins stay transparent — resized, and laid over the
 * media at the computed offset.
 */
export function watermarkFilter(placement: WatermarkPlacement, geometry: Geometry): string {
  const alpha = (clamp(placement.opacity, 1, 100) / 100).toFixed(4);
  return (
    `[1:v]format=rgba,colorchannelmixer=aa=${alpha},` +
    `scale=${geometry.width}:${geometry.height}:flags=lanczos[wm];` +
    `[0:v][wm]overlay=${geometry.x}:${geometry.y}[v]`
  );
}

/** What the media is, as far as re-encoding is concerned. */
export type StampKind = 'photo' | 'video' | 'animation';

/**
 * Aim below the upload ceiling rather than at it. Rate control tracks an
 * average, so it overshoots locally, and the mp4 container adds its own few
 * per cent on top.
 */
const SIZE_TARGET_RATIO = 0.9;

/** Set aside for an audio track we are copying at a bitrate we never asked. */
const AUDIO_BUDGET_BPS = 192_000;

/**
 * A floor worth encoding at. Below this the picture is ruined anyway, so a
 * video that will not fit is better refused than posted as a smear.
 */
const MIN_VIDEO_BPS = 300_000;

/**
 * The bitrate ceiling that keeps the result uploadable, or null when there is
 * no duration to work it out from.
 *
 * Constant-quality encoding has no idea how large its output will be: a source
 * that arrived just under the 50 MB a bot may upload can very easily come back
 * over it, which is a stamped video that then cannot be sent anywhere. Pairing
 * CRF with `-maxrate` keeps the quality-led behaviour on material that is cheap
 * to encode, and caps the rest at something that still fits.
 */
export function videoBitrateCap(duration: number | null, hasAudio: boolean): number | null {
  if (!duration || duration <= 0) return null;

  const budgetBits = MAX_SENDABLE_BYTES * SIZE_TARGET_RATIO * 8;
  const audioBits = hasAudio ? AUDIO_BUDGET_BPS * duration : 0;

  return Math.max(MIN_VIDEO_BPS, Math.floor((budgetBits - audioBits) / duration));
}

/**
 * The arguments after the two inputs. A photo is one frame written back as a
 * high-quality JPEG; video keeps its audio untouched — `0:a?` tolerates a clip
 * that has none — and an animation is video with the audio track dropped, which
 * is what makes Telegram play it as a GIF.
 */
export function encodeArgs(kind: StampKind, bitrateCap: number | null = null): string[] {
  if (kind === 'photo') return ['-map', '[v]', '-frames:v', '1', '-q:v', '2'];

  const video = [
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    // x264 sizes its thread pool from the host's core count, which a container
    // CPU limit does not change — so on a big host it would spin up dozens of
    // threads, each with its own frame buffers, while being throttled to two
    // cores anyway. That is memory spent for no throughput, and on a small
    // container it is what gets the encode OOM-killed. Encodes are serialized
    // here regardless, so a cap costs nothing that matters.
    '-threads',
    '4',
    // Overlaying produces yuva420p; players and Telegram want plain yuv420p.
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    // CRF decides the quality; maxrate is the promise that it will still fit.
    // bufsize is the window that average is held over — one second's worth
    // keeps a busy passage from blowing the budget on its own.
    ...(bitrateCap ? ['-maxrate', String(bitrateCap), '-bufsize', String(bitrateCap * 2)] : []),
  ];

  return kind === 'animation'
    ? [...video, '-an']
    : [...video, '-map', '0:a?', '-c:a', 'copy'];
}

export function buildFfmpegArgs(
  input: string,
  image: string,
  output: string,
  kind: StampKind,
  filter: string,
  bitrateCap: number | null = null,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // Without this the output is mostly carriage-returned progress lines, and
    // the one thing worth reporting — why it stopped — is buried in them.
    '-nostats',
    '-y',
    '-i',
    input,
    '-i',
    image,
    '-filter_complex',
    filter,
    ...encodeArgs(kind, bitrateCap),
    output,
  ];
}

// --- Measuring --------------------------------------------------------------

export function buildFfprobeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    // The first video stream is the picture; a cover image on an audio file
    // would be a second one, and album art is not what we are stamping.
    '-select_streams',
    'v:0',
    // Duration comes from the container rather than the stream: it is the one
    // both a merged download and a Telegram video reliably carry, and the size
    // budget below is worked out from it.
    '-show_entries',
    'stream=width,height:format=duration',
    '-of',
    'csv=p=0',
    file,
  ];
}

/** A measured file: how big the picture is, and how long it runs. */
export type Probe = Size & { duration: number | null };

/** `1920,1080` on one line and `71.100000` on the next, in either order. */
export function parseProbe(stdout: string): Probe | null {
  let size: Size | null = null;
  let duration: number | null = null;

  for (const raw of stdout.split('\n')) {
    const parts = raw.trim().split(',').map(Number);
    const [first, second] = parts;

    if (
      parts.length >= 2 &&
      Number.isInteger(first) &&
      Number.isInteger(second) &&
      first! > 0 &&
      second! > 0
    ) {
      size ??= { width: first!, height: second! };
    } else if (parts.length === 1 && Number.isFinite(first) && first! > 0) {
      duration ??= first!;
    }
  }

  // Without a picture there is nothing to stamp; a missing duration only costs
  // the size budget, so it is not on its own a reason to give up.
  return size ? { ...size, duration } : null;
}

async function measure(file: string): Promise<Probe | null> {
  const result = await runCommand(FFPROBE, buildFfprobeArgs(file), {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.spawnError || result.timedOut) return null;
  return parseProbe(result.stdout);
}

// --- Stamping ---------------------------------------------------------------

export type StampResult =
  | { ok: true; file: string; bytes: number; cleanup: () => Promise<void> }
  | { ok: false; error: string };

/** A stamped file keeps a photo a photo, but every moving picture becomes mp4. */
function outputName(kind: StampKind): string {
  return kind === 'photo' ? 'stamped.jpg' : 'stamped.mp4';
}

/**
 * Draws the configured watermark onto `input` and returns the new file, which
 * lives in a temporary directory the caller closes with `cleanup`.
 *
 * Never throws: a missing ffmpeg, an unreadable file and a filter that would
 * not build all come back as `ok: false` with something worth showing a person,
 * because every caller has a fallback and none of them should crash a handler.
 */
export function stampFile(
  input: string,
  kind: StampKind,
  placement: WatermarkPlacement,
): Promise<StampResult> {
  return exclusiveEncode(() => stampNow(input, kind, placement));
}

async function stampNow(
  input: string,
  kind: StampKind,
  placement: WatermarkPlacement,
): Promise<StampResult> {
  if (!hasWatermarkImage()) {
    return { ok: false, error: 'No watermark image is configured.' };
  }

  const [media, image] = await Promise.all([measure(input), measure(env.watermarkPath)]);
  if (!media) {
    return {
      ok: false,
      error:
        'Could not measure the media — ffprobe is missing, or the file holds no picture to stamp.',
    };
  }
  if (!image) return { ok: false, error: 'The stored watermark is not a readable PNG.' };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-poster-wm-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fail = async (error: string): Promise<StampResult> => {
    await cleanup().catch(() => undefined);
    return { ok: false, error };
  };

  const output = path.join(dir, outputName(kind));
  const filter = watermarkFilter(placement, overlayGeometry(placement, media, image));
  // A photo is one frame and never near the ceiling; only moving pictures need
  // to be held to a budget.
  const bitrateCap =
    kind === 'photo' ? null : videoBitrateCap(media.duration, kind !== 'animation');

  const result = await runCommand(
    FFMPEG,
    buildFfmpegArgs(input, env.watermarkPath, output, kind, filter, bitrateCap),
    { timeoutMs: TIMEOUT_MS },
  );

  if (result.spawnError) {
    return fail(
      result.spawnError.code === 'ENOENT'
        ? 'ffmpeg is not installed on the server — the dashboard shows the media tools.'
        : `Could not run ffmpeg: ${result.spawnError.message}`,
    );
  }
  if (result.timedOut) {
    return fail(`Watermarking did not finish within ${TIMEOUT_MS / 60_000} minutes.`);
  }

  // An ffmpeg that gave up part-way still leaves the bytes it had already
  // written, so "the file is there" proves nothing on its own. A null code is
  // a process that died on a signal — on a memory-capped host, that is the
  // kernel's OOM killer reaping the encode.
  if (result.code !== 0) {
    return fail(
      result.code === null
        ? 'ffmpeg was killed before it finished — on a memory-capped host this is usually the encode being reaped for using too much memory.'
        : (summarizeFfmpegError(result.output) ??
           `ffmpeg stopped with exit code ${result.code} without saying why — the encode was cut short.`),
    );
  }

  const info = await stat(output).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    return fail(summarizeFfmpegError(result.output) ?? 'ffmpeg produced no file.');
  }

  // A file can be the right size and still be rubble: an mp4 whose moov atom
  // was never written plays nowhere. Telegram accepts one happily and then
  // shows a black rectangle for however long we said the video was, so the
  // cheapest honest proof that this is worth uploading is to measure it.
  if (!(await measure(output))) {
    return fail('ffmpeg produced a file that cannot be played back.');
  }

  // Re-encoding can grow a file, and a stamped video too large to upload is no
  // more use than one that was never stamped.
  if (info.size > MAX_SENDABLE_BYTES) {
    return fail(
      `The watermarked file is ${formatBytes(info.size)}, over the ` +
        `${formatBytes(MAX_SENDABLE_BYTES)} a bot may upload.`,
    );
  }

  return { ok: true, file: output, bytes: info.size, cleanup };
}

/** Lines that read like ffmpeg objecting to something, rather than narrating. */
const COMPLAINT =
  /(error|invalid|failed|unable|unsupported|no such file|not found|denied|killed|cannot)/i;

/**
 * ffmpeg's own account of what went wrong, or null when it never said.
 *
 * Progress is written with carriage returns rather than newlines, so the split
 * has to take both or the whole run arrives as one enormous line. Only lines
 * that read like a complaint count: ffmpeg signs off with stream metadata and
 * encoder statistics, and answering "why did this fail?" with `handler_name:
 * SoundHandler` is worse than admitting it gave no reason — which is exactly
 * what a process that was killed outright does.
 */
export function summarizeFfmpegError(output: string): string | null {
  const complaint = output
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => COMPLAINT.test(line))
    .at(-1);

  return complaint ? complaint.slice(0, 300) : null;
}

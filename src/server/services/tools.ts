import { notifyDashboard } from '../events.js';
import { runCommand } from '../util/exec.js';
import { truncate } from '../util/format.js';

/**
 * Both are looked up on `PATH`. The Docker image installs yt-dlp into a
 * directory the app user can write to, which is what lets it update itself.
 */
export const YT_DLP = 'yt-dlp';
export const FFMPEG = 'ffmpeg';
/** Ships in the same package as ffmpeg everywhere; used to measure media. */
export const FFPROBE = 'ffprobe';

const VERSION_TIMEOUT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 3 * 60_000;
/** yt-dlp ships fixes for sites that changed overnight, so check daily. */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

const NOT_INSTALLED = 'Not installed, or not on PATH.';

/**
 * One yt-dlp run at a time, for everything except reading the version.
 *
 * Downloads are heavy enough to want serializing on a small host anyway, but
 * the real reason is the updater: it rewrites the very file a running download
 * is executing from, so those two must never overlap.
 */
let ytDlpQueue: Promise<unknown> = Promise.resolve();

export function exclusiveYtDlp<T>(task: () => Promise<T>): Promise<T> {
  const result = ytDlpQueue.then(task, task);
  ytDlpQueue = result.catch(() => undefined);
  return result;
}

// --- Parsing ----------------------------------------------------------------

/** `yt-dlp --version` prints the version and nothing else. */
export function parseYtDlpVersion(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean);
  return line && /\d/.test(line) ? truncate(line, 40) : null;
}

/** `ffmpeg -version` opens with `ffmpeg version 6.1.1-alpine …`. */
export function parseFfmpegVersion(stdout: string): string | null {
  const match = /^ffmpeg version (\S+)/m.exec(stdout);
  return match?.[1] ? truncate(match[1], 40) : null;
}

/**
 * A tool's own words: the last `ERROR:` line, without the prefix and yt-dlp's
 * "please report this issue" boilerplate. Null when it said nothing useful.
 */
export function summarizeYtDlpError(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const errors = lines.filter((line) => line.startsWith('ERROR:'));
  const last = errors.at(-1) ?? lines.at(-1);
  if (!last) return null;

  const cleaned = last
    .replace(/^ERROR:\s*/, '')
    .replace(/;?\s*(please report this issue|confirm you are on the latest version).*$/i, '')
    .trim();

  return cleaned ? truncate(cleaned, 300) : null;
}

export type UpdateOutcome = 'updated' | 'up-to-date' | 'unsupported' | 'failed';

/**
 * What `yt-dlp -U` did. `unsupported` is the normal answer for an install the
 * updater refuses to touch — a distro package, pip, or a source checkout — and
 * is not a fault worth alarming anyone about.
 */
export function classifyUpdate(output: string, code: number | null): {
  outcome: UpdateOutcome;
  message: string;
} {
  if (/\bis up to date\b/i.test(output)) {
    return { outcome: 'up-to-date', message: 'Already on the latest release.' };
  }

  const updated = /Updated yt-dlp to\s+(\S+)/i.exec(output);
  if (updated) {
    return { outcome: 'updated', message: `Updated to ${truncate(updated[1] ?? '', 40)}.` };
  }

  if (/package manager|not updateable|please use that to update|installed from source/i.test(output)) {
    return {
      outcome: 'unsupported',
      message:
        'This yt-dlp was installed by a package manager, so it updates the same way — ' +
        'the bundled Docker image installs one that can update itself.',
    };
  }

  return {
    outcome: 'failed',
    message: summarizeYtDlpError(output) ?? `yt-dlp -U exited with code ${code ?? 'unknown'}.`,
  };
}

// --- State ------------------------------------------------------------------

export type ToolStatus = {
  version: string | null;
  /** Why it is unusable, or null when it answered. */
  error: string | null;
};

export type ToolsState = {
  ytDlp: ToolStatus;
  ffmpeg: ToolStatus;
  /** When the versions below were last read. */
  checkedAt: Date | null;
  updating: boolean;
  lastUpdate: { at: Date; outcome: UpdateOutcome; message: string } | null;
  nextCheckAt: Date | null;
};

const unknown = (): ToolStatus => ({ version: null, error: null });

let state: ToolsState = {
  ytDlp: unknown(),
  ffmpeg: unknown(),
  checkedAt: null,
  updating: false,
  lastUpdate: null,
  nextCheckAt: null,
};

export function toolsState(): ToolsState {
  return state;
}

async function probe(
  command: string,
  args: string[],
  parse: (stdout: string) => string | null,
): Promise<ToolStatus> {
  const result = await runCommand(command, args, { timeoutMs: VERSION_TIMEOUT_MS });

  if (result.spawnError) {
    return {
      version: null,
      error: result.spawnError.code === 'ENOENT' ? NOT_INSTALLED : result.spawnError.message,
    };
  }
  if (result.timedOut) return { version: null, error: `${command} did not answer in time.` };

  const version = parse(result.stdout);
  if (version) return { version, error: null };

  // Installed but not answering properly — a broken interpreter, say. Whatever
  // it complained about is the most useful thing to show.
  return {
    version: null,
    error: summarizeYtDlpError(result.output) ?? `${command} reported no version.`,
  };
}

/** Reads both versions and tells the dashboard. */
export async function probeTools(): Promise<ToolsState> {
  const [ytDlp, ffmpeg] = await Promise.all([
    probe(YT_DLP, ['--version'], parseYtDlpVersion),
    probe(FFMPEG, ['-version'], parseFfmpegVersion),
  ]);

  state = { ...state, ytDlp, ffmpeg, checkedAt: new Date() };
  notifyDashboard();
  return state;
}

/**
 * Updates yt-dlp in place with its own updater, then re-reads both versions.
 *
 * ffmpeg has no self-update — no build of it does — so it is only re-read here.
 * It comes from the image and moves forward when a new image is pulled, which
 * is no loss: ffmpeg only muxes the streams yt-dlp hands it, and that interface
 * does not drift the way extractors do.
 */
export async function updateTools(): Promise<ToolsState> {
  if (state.updating) return state;

  state = { ...state, updating: true };
  notifyDashboard();

  try {
    // Waits for any download in flight; see exclusiveYtDlp.
    const result = await exclusiveYtDlp(() =>
      runCommand(YT_DLP, ['-U'], { timeoutMs: UPDATE_TIMEOUT_MS }),
    );

    let outcome: UpdateOutcome;
    let message: string;

    if (result.spawnError) {
      outcome = 'failed';
      message = result.spawnError.code === 'ENOENT' ? NOT_INSTALLED : result.spawnError.message;
    } else if (result.timedOut) {
      outcome = 'failed';
      message = `The update did not finish within ${UPDATE_TIMEOUT_MS / 60_000} minutes.`;
    } else {
      ({ outcome, message } = classifyUpdate(result.output, result.code));
    }

    state = { ...state, lastUpdate: { at: new Date(), outcome, message } };
    const label = outcome === 'failed' ? 'warn' : 'log';
    console[label](`[tools] yt-dlp update: ${outcome} — ${message}`);
  } finally {
    state = { ...state, updating: false };
  }

  return probeTools();
}

// --- Schedule ---------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;

async function runCheck(label: string): Promise<void> {
  state = { ...state, nextCheckAt: new Date(Date.now() + CHECK_INTERVAL_MS) };
  try {
    await updateTools();
  } catch (error) {
    console.error(`[tools] ${label} failed`, error);
    notifyDashboard();
  }
}

/** Checks at boot, then daily. Safe to call twice. */
export function startToolMaintenance(): void {
  if (timer) return;
  timer = setInterval(() => void runCheck('scheduled check'), CHECK_INTERVAL_MS);
  void runCheck('first check');
}

export function stopToolMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  state = { ...state, nextCheckAt: null };
}

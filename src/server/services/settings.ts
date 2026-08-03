import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings, type Settings } from '../db/schema.js';
import { env } from '../env.js';
import { notifyDashboard } from '../events.js';

const SETTINGS_ID = 1;

export const DEFAULT_DELAY_MINUTES = 60;
export const MIN_DELAY_MINUTES = 1;
export const MAX_DELAY_MINUTES = 60 * 24 * 30;

/**
 * A caption may hold 1024 characters in total, so the footer has to leave the
 * post itself most of the room — it is a sign-off, not a second post.
 */
export const MAX_FOOTER_LENGTH = 400;

/** Creates the singleton row on first boot, seeded from env when provided. */
export function ensureSettings(): Settings {
  const existing = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  if (existing) return existing;

  db.insert(settings)
    .values({
      id: SETTINGS_ID,
      botToken: env.initialBotToken,
      delayMinutes: DEFAULT_DELAY_MINUTES,
      timezone: env.initialTimezone,
      updatedAt: new Date(),
    })
    .run();

  return getSettings();
}

export function getSettings(): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  if (!row) return ensureSettings();
  return row;
}

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'botToken'
    | 'targetChannelId'
    | 'delayMinutes'
    | 'timezone'
    | 'paused'
    | 'postFooter'
    | 'windowStart'
    | 'windowEnd'
    | 'queueRawOnFailure'
    | 'downloadMetadata'
    | 'watermarkEnabled'
    | 'watermarkX'
    | 'watermarkY'
    | 'watermarkOpacity'
    | 'watermarkScale'
    | 'watermarkRequired'
  >
>;

/** The percentage settings the watermark is described by, and their bounds. */
export const WATERMARK_LIMITS = {
  watermarkX: { min: 0, max: 100 },
  watermarkY: { min: 0, max: 100 },
  // A watermark at 0% opacity is an invisible one, which is what the enable
  // switch is for; a 0%-wide one is nothing at all.
  watermarkOpacity: { min: 1, max: 100 },
  watermarkScale: { min: 1, max: 100 },
} as const;

/** Where and how the watermark is drawn, independent of whether it is on. */
export type WatermarkPlacement = {
  /** 0 = flush left, 50 = centred, 100 = flush right. Same for `y`, vertically. */
  x: number;
  y: number;
  /** 1–100, applied on top of the PNG's own alpha. */
  opacity: number;
  /** Watermark width as a percentage of the media's width. */
  scale: number;
};

export function watermarkPlacement(settings: Settings): WatermarkPlacement {
  return {
    x: settings.watermarkX,
    y: settings.watermarkY,
    opacity: settings.watermarkOpacity,
    scale: settings.watermarkScale,
  };
}

/** The hours posting is allowed in, or null when it may happen at any time. */
export type PostingWindow = { start: number; end: number };

export function postingWindow(settings: Settings): PostingWindow | null {
  const { windowStart, windowEnd } = settings;
  if (windowStart === null || windowEnd === null) return null;
  // Start and end on the same minute would be a window nothing fits through;
  // it means "no window" instead of never posting again.
  if (windowStart === windowEnd) return null;
  return { start: windowStart, end: windowEnd };
}

/** The footer to append to every post, or null when there is nothing to add. */
export function postFooter(settings: Settings): string | null {
  return settings.postFooter?.trim() || null;
}

export function isPaused(): boolean {
  return getSettings().paused;
}

/** Returns the new state. */
export function setPaused(paused: boolean): boolean {
  return updateSettings({ paused }).paused;
}

export function updateSettings(patch: SettingsPatch): Settings {
  db.update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, SETTINGS_ID))
    .run();
  notifyDashboard();
  return getSettings();
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Telegram numeric ids: positive for users, negative (`-100…`) for channels. */
export function isValidTelegramId(value: string): boolean {
  return /^-?\d{1,20}$/.test(value);
}

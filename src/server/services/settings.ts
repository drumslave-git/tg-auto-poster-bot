import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings, type Settings } from '../db/schema.js';
import { env } from '../env.js';

const SETTINGS_ID = 1;

export const DEFAULT_DELAY_MINUTES = 60;
export const MIN_DELAY_MINUTES = 1;
export const MAX_DELAY_MINUTES = 60 * 24 * 30;

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
  Pick<Settings, 'botToken' | 'targetChannelId' | 'delayMinutes' | 'timezone' | 'paused'>
>;

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

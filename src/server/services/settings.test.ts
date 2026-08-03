import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/index.js';
import { settings as settingsTable } from '../db/schema.js';
import { onDashboardChange } from '../events.js';
import { resetDb } from '../test/db.js';
import {
  DEFAULT_DELAY_MINUTES,
  ensureSettings,
  getSettings,
  isPaused,
  isValidTelegramId,
  isValidTimezone,
  setPaused,
  updateSettings,
} from './settings.js';

beforeEach(() => {
  resetDb();
});

describe('ensureSettings', () => {
  it('creates the singleton row with the defaults', () => {
    const created = ensureSettings();

    expect(created.id).toBe(1);
    expect(created.delayMinutes).toBe(DEFAULT_DELAY_MINUTES);
    expect(created.timezone).toBe('UTC');
    expect(created.botToken).toBeNull();
    expect(created.paused).toBe(false);
    expect(created.postFooter).toBeNull();
    expect(created.windowStart).toBeNull();
    expect(created.windowEnd).toBeNull();
    // A failed download stays a failure unless asked otherwise; the title and
    // source line have always been there, so they stay on by default.
    expect(created.queueRawOnFailure).toBe(false);
    expect(created.downloadMetadata).toBe(true);
  });

  it('never creates a second row', () => {
    ensureSettings();
    updateSettings({ delayMinutes: 42 });

    const again = ensureSettings();

    expect(again.delayMinutes).toBe(42);
    expect(db.select().from(settingsTable).all()).toHaveLength(1);
  });
});

describe('getSettings', () => {
  it('creates the row when it is missing', () => {
    expect(db.select().from(settingsTable).all()).toHaveLength(0);

    expect(getSettings().delayMinutes).toBe(DEFAULT_DELAY_MINUTES);
  });
});

describe('updateSettings', () => {
  beforeEach(() => {
    ensureSettings();
  });

  it('applies a partial patch and leaves the rest alone', () => {
    updateSettings({ timezone: 'Europe/Berlin' });

    const updated = updateSettings({ delayMinutes: 15 });

    expect(updated.delayMinutes).toBe(15);
    expect(updated.timezone).toBe('Europe/Berlin');
  });

  it('stores nullable fields as null', () => {
    updateSettings({ botToken: '123:abc', targetChannelId: '-100123' });

    const cleared = updateSettings({ botToken: null, targetChannelId: null });

    expect(cleared.botToken).toBeNull();
    expect(cleared.targetChannelId).toBeNull();
  });

  it('stamps updatedAt', () => {
    const before = getSettings().updatedAt;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(before.getTime() + 60_000));

    const updated = updateSettings({ delayMinutes: 30 });

    vi.useRealTimers();
    expect(updated.updatedAt.getTime()).toBe(before.getTime() + 60_000);
  });

  it('tells the dashboard something changed', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);

    updateSettings({ delayMinutes: 20 });

    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe('pausing', () => {
  beforeEach(() => {
    ensureSettings();
  });

  it('starts unpaused', () => {
    expect(isPaused()).toBe(false);
  });

  it('round-trips through the settings row', () => {
    expect(setPaused(true)).toBe(true);
    expect(isPaused()).toBe(true);

    expect(setPaused(false)).toBe(false);
    expect(isPaused()).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zones', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('isValidTelegramId', () => {
  it('accepts user and channel ids', () => {
    expect(isValidTelegramId('12345')).toBe(true);
    expect(isValidTelegramId('-1001234567890')).toBe(true);
  });

  it('rejects anything that is not a plain number', () => {
    expect(isValidTelegramId('')).toBe(false);
    expect(isValidTelegramId('@channel')).toBe(false);
    expect(isValidTelegramId('12 34')).toBe(false);
    expect(isValidTelegramId('1'.repeat(21))).toBe(false);
  });
});

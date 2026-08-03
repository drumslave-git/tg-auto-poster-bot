import { describe, expect, it } from 'vitest';
import {
  formatClock,
  minutesOfDay,
  nextWindowOpen,
  parseClock,
  withinWindow,
  zonedParts,
  zonedTimeToUtc,
} from './time.js';

describe('zonedParts', () => {
  it('reads the clock in the zone, not the host', () => {
    expect(zonedParts(new Date('2026-05-01T12:00:00Z'), 'UTC')).toEqual({
      year: 2026,
      month: 5,
      day: 1,
      hour: 12,
      minute: 0,
      second: 0,
    });
  });

  it('reports midnight as hour 0', () => {
    expect(zonedParts(new Date('2026-05-01T00:00:00Z'), 'UTC').hour).toBe(0);
  });

  it('rolls over the date when the zone is a day ahead', () => {
    // 23:00 UTC is already the next morning in Tokyo.
    expect(zonedParts(new Date('2026-05-01T23:00:00Z'), 'Asia/Tokyo')).toMatchObject({
      day: 2,
      hour: 8,
    });
  });
});

describe('minutesOfDay', () => {
  it('counts from local midnight', () => {
    expect(minutesOfDay(new Date('2026-05-01T13:30:00Z'), 'UTC')).toBe(13 * 60 + 30);
  });

  it('follows the zone into summer time', () => {
    // New York is UTC-4 in May, UTC-5 in January.
    expect(minutesOfDay(new Date('2026-05-01T17:00:00Z'), 'America/New_York')).toBe(13 * 60);
    expect(minutesOfDay(new Date('2026-01-01T17:00:00Z'), 'America/New_York')).toBe(12 * 60);
  });
});

describe('withinWindow', () => {
  it('includes the start and excludes the end', () => {
    expect(withinWindow(13 * 60, 13 * 60, 17 * 60)).toBe(true);
    expect(withinWindow(17 * 60 - 1, 13 * 60, 17 * 60)).toBe(true);
    expect(withinWindow(17 * 60, 13 * 60, 17 * 60)).toBe(false);
    expect(withinWindow(13 * 60 - 1, 13 * 60, 17 * 60)).toBe(false);
  });

  it('wraps past midnight when the start is after the end', () => {
    const late = (minutes: number) => withinWindow(minutes, 22 * 60, 2 * 60);

    expect(late(23 * 60)).toBe(true);
    expect(late(0)).toBe(true);
    expect(late(60)).toBe(true);
    expect(late(2 * 60)).toBe(false);
    expect(late(12 * 60)).toBe(false);
  });
});

describe('zonedTimeToUtc', () => {
  it('finds the instant a local clock reads that time', () => {
    expect(zonedTimeToUtc(2026, 5, 1, 13 * 60, 'UTC').toISOString()).toBe('2026-05-01T13:00:00.000Z');
    // 13:00 in New York is 17:00 UTC in May and 18:00 UTC in January.
    expect(zonedTimeToUtc(2026, 5, 1, 13 * 60, 'America/New_York').toISOString()).toBe(
      '2026-05-01T17:00:00.000Z',
    );
    expect(zonedTimeToUtc(2026, 1, 1, 13 * 60, 'America/New_York').toISOString()).toBe(
      '2026-01-01T18:00:00.000Z',
    );
  });

  it('round-trips through the clock it came from', () => {
    for (const zone of ['UTC', 'Europe/Kyiv', 'America/New_York', 'Asia/Kolkata']) {
      const instant = zonedTimeToUtc(2026, 7, 15, 9 * 60 + 45, zone);
      expect(minutesOfDay(instant, zone)).toBe(9 * 60 + 45);
    }
  });

  it('takes the first of two readings on the day the clocks go back', () => {
    // 01:30 happens twice in New York on 2026-11-01; the earlier one is EDT.
    expect(zonedTimeToUtc(2026, 11, 1, 90, 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('lands past the gap for a reading the clocks skipped', () => {
    // New York jumps 02:00 → 03:00 on 2026-03-08, so 02:30 never happens.
    const skipped = zonedTimeToUtc(2026, 3, 8, 150, 'America/New_York');

    expect(skipped.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-03-08T07:00:00Z'));
    // Still the same local day, not a jump into tomorrow.
    expect(zonedParts(skipped, 'America/New_York').day).toBe(8);
  });
});

describe('nextWindowOpen', () => {
  const open = (iso: string, start: number, zone = 'UTC') =>
    nextWindowOpen(new Date(iso), zone, start).toISOString();

  it('returns today when the window has not opened yet', () => {
    expect(open('2026-05-01T09:00:00Z', 13 * 60)).toBe('2026-05-01T13:00:00.000Z');
  });

  it('returns the moment itself when it is exactly the opening', () => {
    expect(open('2026-05-01T13:00:00Z', 13 * 60)).toBe('2026-05-01T13:00:00.000Z');
  });

  it('rolls to tomorrow once today’s opening has passed', () => {
    expect(open('2026-05-01T19:00:00Z', 13 * 60)).toBe('2026-05-02T13:00:00.000Z');
  });

  it('opens by the local clock, not UTC', () => {
    // 22:00 UTC on 30 April is already 01:00 on 1 May in Kyiv, so the next
    // 13:00 opening is that same local day.
    expect(open('2026-04-30T22:00:00Z', 13 * 60, 'Europe/Kyiv')).toBe('2026-05-01T10:00:00.000Z');
  });

  it('keeps the wall time across a daylight-saving change', () => {
    // Kyiv leaves summer time on 25 October 2026; 13:00 stays 13:00 either way.
    const before = nextWindowOpen(new Date('2026-10-24T14:00:00Z'), 'Europe/Kyiv', 13 * 60);
    const after = nextWindowOpen(new Date('2026-10-25T14:00:00Z'), 'Europe/Kyiv', 13 * 60);

    expect(minutesOfDay(before, 'Europe/Kyiv')).toBe(13 * 60);
    expect(minutesOfDay(after, 'Europe/Kyiv')).toBe(13 * 60);
  });
});

describe('formatClock', () => {
  it('pads both halves', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(9 * 60 + 5)).toBe('09:05');
    expect(formatClock(13 * 60 + 30)).toBe('13:30');
    expect(formatClock(23 * 60 + 59)).toBe('23:59');
  });
});

describe('parseClock', () => {
  it('reads a time of day', () => {
    expect(parseClock('13:00')).toBe(13 * 60);
    expect(parseClock('09:05')).toBe(9 * 60 + 5);
    expect(parseClock('9:05')).toBe(9 * 60 + 5);
    expect(parseClock(' 00:00 ')).toBe(0);
  });

  it('rejects anything that is not one', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('12')).toBeNull();
    expect(parseClock('12:5')).toBeNull();
    expect(parseClock('noon')).toBeNull();
  });
});

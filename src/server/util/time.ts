/**
 * Wall-clock arithmetic in the configured time zone, built on `Intl` alone.
 *
 * The posting window is a pair of clock times ("13:00 to 17:00"), and clock
 * times only mean something in a zone: 13:00 in Europe/Kyiv is a different
 * instant in summer than in winter. Everything here converts between an instant
 * (a `Date`) and what a clock in that zone reads at that instant.
 */

export const MINUTES_IN_DAY = 24 * 60;

/** Building an `Intl.DateTimeFormat` is the expensive part; there are few zones. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;

  // h23 so midnight reads as 00, not 24 — `hour12: false` alone still yields 24.
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** What a clock in `timeZone` reads at this instant. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Minutes since local midnight, 0–1439. */
export function minutesOfDay(date: Date, timeZone: string): number {
  const { hour, minute } = zonedParts(date, timeZone);
  return hour * 60 + minute;
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function offsetAt(timestamp: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = zonedParts(new Date(timestamp), timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - timestamp;
}

/**
 * The instant at which a clock in `timeZone` reads this date and time.
 *
 * The offset is only knowable from an instant, and the instant is what we are
 * solving for. So: guess with the offset in force at the same reading in UTC,
 * then check the guess against the offset it actually landed in. A candidate
 * that agrees with its own offset is the answer, and on an autumn day when the
 * hour repeats, the first candidate is the earlier of the two readings.
 *
 * Neither agreeing means the reading is one a spring-forward skipped and no
 * instant has it. The later candidate is then the nearest moment past the gap —
 * the clock never shows this time, but it is through it by then.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutesIntoDay: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minutesIntoDay);

  const first = wall - offsetAt(wall, timeZone);
  if (offsetAt(first, timeZone) === wall - first) return new Date(first);

  const second = wall - offsetAt(first, timeZone);
  if (offsetAt(second, timeZone) === wall - second) return new Date(second);

  return new Date(Math.max(first, second));
}

/**
 * Is this clock reading inside the window? The end is exclusive, so 13:00–17:00
 * posts up to 16:59. A window whose start is after its end wraps past midnight.
 */
export function withinWindow(minutes: number, start: number, end: number): boolean {
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The first moment at or after `from` at which the window opens. Callers ask
 * this only when `from` itself is outside the window, so today's opening either
 * still lies ahead or has already closed — in which case it is tomorrow's.
 */
export function nextWindowOpen(from: Date, timeZone: string, start: number): Date {
  const { year, month, day } = zonedParts(from, timeZone);
  const today = zonedTimeToUtc(year, month, day, start, timeZone);
  if (today.getTime() >= from.getTime()) return today;

  // The next local day, found by stepping the calendar date rather than adding
  // 24 hours — a DST day is 23 or 25 hours long.
  const tomorrow = new Date(Date.UTC(year, month - 1, day) + MINUTES_IN_DAY * 60_000);
  return zonedTimeToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    start,
    timeZone,
  );
}

/** `810` → `13:30`. */
export function formatClock(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** `13:30` → `810`, or null when it is not a time of day. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

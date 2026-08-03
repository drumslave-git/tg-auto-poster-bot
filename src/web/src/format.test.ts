import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration, formatRunway, typeIcon } from './format';

describe('formatDuration', () => {
  it('shows a zeroed clock for anything already due', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(-1)).toBe('00:00:00');
  });

  it('renders hh:mm:ss', () => {
    expect(formatDuration(3_723_000)).toBe('01:02:03');
    expect(formatDuration(59_000)).toBe('00:00:59');
  });

  it('prefixes whole days', () => {
    expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe('2d 01:00:00');
  });

  it('truncates rather than rounds, so the countdown never overshoots', () => {
    expect(formatDuration(1_999)).toBe('00:00:01');
  });
});

describe('formatRunway', () => {
  it('dashes out an empty runway', () => {
    expect(formatRunway(0)).toBe('—');
    expect(formatRunway(-1)).toBe('—');
  });

  it('keeps only the units that matter', () => {
    expect(formatRunway(90 * 60_000)).toBe('1h 30m');
    expect(formatRunway(26 * 60 * 60_000)).toBe('1d 2h');
    expect(formatRunway(24 * 60 * 60_000)).toBe('1d');
  });

  it('always shows something for a sub-minute runway', () => {
    expect(formatRunway(30_000)).toBe('0m');
  });
});

describe('formatDateTime', () => {
  it('dashes out missing and unparseable values', () => {
    expect(formatDateTime(null, 'UTC')).toBe('—');
    expect(formatDateTime('not a date', 'UTC')).toBe('—');
  });

  it('formats ISO strings and epoch milliseconds alike', () => {
    const iso = '2026-03-01T12:34:56Z';
    expect(formatDateTime(iso, 'UTC')).toBe('01 Mar, 12:34');
    expect(formatDateTime(Date.parse(iso), 'UTC')).toBe('01 Mar, 12:34');
  });

  it('renders in the requested zone', () => {
    expect(formatDateTime('2026-03-01T12:34:56Z', 'Europe/Berlin')).toBe('01 Mar, 13:34');
  });

  it('falls back to ISO for a bogus zone', () => {
    expect(formatDateTime('2026-03-01T12:34:56Z', 'Mars/Olympus')).toBe('2026-03-01T12:34:56.000Z');
  });
});

describe('typeIcon', () => {
  it('has an icon per known content type', () => {
    expect(typeIcon('photo')).toBe('🖼');
    expect(typeIcon('album')).toBe('🗂');
  });

  it('falls back to a parcel', () => {
    expect(typeIcon('hologram')).toBe('📦');
  });
});

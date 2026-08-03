import { describe, expect, it } from 'vitest';
import { contentTypeLabel, escapeHtml, formatDuration, formatInTimezone, truncate } from './format.js';

describe('formatDuration', () => {
  it('says "now" for anything already due', () => {
    expect(formatDuration(0)).toBe('now');
    expect(formatDuration(-5_000)).toBe('now');
  });

  it('drops to seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('pads seconds under an hour', () => {
    expect(formatDuration(45 * 60_000 + 12_000)).toBe('45m 12s');
    expect(formatDuration(60_000 + 5_000)).toBe('1m 05s');
  });

  it('pads minutes under a day', () => {
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m');
  });

  it('shows days with padded hours and minutes', () => {
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 9 * 60_000)).toBe('3d 04h 09m');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(1_600)).toBe('2s');
  });
});

describe('formatInTimezone', () => {
  const date = new Date('2026-03-01T12:34:56Z');

  it('renders in the requested zone', () => {
    expect(formatInTimezone(date, 'UTC')).toBe('01 Mar 2026, 12:34');
  });

  it('shifts with the zone', () => {
    expect(formatInTimezone(date, 'Europe/Berlin')).toBe('01 Mar 2026, 13:34');
  });

  it('falls back to ISO for a bogus zone', () => {
    expect(formatInTimezone(date, 'Mars/Olympus')).toBe(date.toISOString());
  });
});

describe('contentTypeLabel', () => {
  it('maps known types to friendly labels', () => {
    expect(contentTypeLabel('animation')).toBe('GIF');
    expect(contentTypeLabel('video_note')).toBe('video note');
  });

  it('passes unknown types through', () => {
    expect(contentTypeLabel('hologram')).toBe('hologram');
  });
});

describe('truncate', () => {
  it('collapses whitespace and trims', () => {
    expect(truncate('  a \n\t b  ')).toBe('a b');
  });

  it('leaves short values alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('cuts to max including the ellipsis', () => {
    const result = truncate('abcdefghij', 5);
    expect(result).toBe('abcd…');
    expect(result).toHaveLength(5);
  });

  it('defaults to 140 characters', () => {
    expect(truncate('x'.repeat(200))).toHaveLength(140);
  });
});

describe('escapeHtml', () => {
  it('escapes the three characters Telegram parses', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });

  it('escapes ampersands before the angle brackets it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

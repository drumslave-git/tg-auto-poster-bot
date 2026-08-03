/** Human duration, e.g. `2h 05m`, `45m 12s`, `now`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSeconds = Math.round(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

export function formatInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

const MEDIA_LABELS: Record<string, string> = {
  text: 'text',
  photo: 'photo',
  video: 'video',
  animation: 'GIF',
  document: 'document',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video note',
  sticker: 'sticker',
  poll: 'poll',
  location: 'location',
  contact: 'contact',
  album: 'album',
};

export function contentTypeLabel(contentType: string): string {
  return MEDIA_LABELS[contentType] ?? contentType;
}

/** Human file size, e.g. `48.6 MB`, `50 MB`, `823 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  // A round number reads better without the decimal: `50 MB`, not `50.0 MB`.
  return `${(kilobytes / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function truncate(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/**
 * Cuts a string to `max` UTF-16 units without splitting a surrogate pair —
 * half an emoji is not a character, and Telegram counts these units too.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = max > 0 && isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max;
  return value.slice(0, cut);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Like `truncate`, but keeps the line breaks the writer put in. */
export function truncateLines(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${clip(trimmed, max - 1)}…` : trimmed;
}

/** Telegram HTML parse mode escaping. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

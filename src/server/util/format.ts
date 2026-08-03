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

export function truncate(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Telegram HTML parse mode escaping. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

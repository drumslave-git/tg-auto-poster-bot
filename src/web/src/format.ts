export function formatDuration(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function formatRunway(ms: number): string {
  if (ms <= 0) return '—';
  const total = Math.floor(ms / 60000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatDateTime(value: string | number | null, timezone: string): string {
  if (value === null) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

const TYPE_ICONS: Record<string, string> = {
  text: '📝',
  photo: '🖼',
  video: '🎬',
  animation: '🎞',
  document: '📎',
  audio: '🎵',
  voice: '🎙',
  video_note: '⭕',
  sticker: '🩹',
  poll: '📊',
  location: '📍',
  contact: '👤',
  album: '🗂',
};

export function typeIcon(contentType: string): string {
  return TYPE_ICONS[contentType] ?? '📦';
}

import type { PostRecord, QueueItem, Role, Status, User } from './types';

const PASSWORD_KEY = 'tg-poster-dashboard-password';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export function getPassword(): string {
  return localStorage.getItem(PASSWORD_KEY) ?? '';
}

export function setPassword(value: string): void {
  if (value) localStorage.setItem(PASSWORD_KEY, value);
  else localStorage.removeItem(PASSWORD_KEY);
}

export function authHeaders(): Record<string, string> {
  const password = getPassword();
  return password ? { 'x-dashboard-password': password } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...init?.headers,
    },
  });

  if (response.status === 401) throw new UnauthorizedError();

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `Request failed (${response.status})`));
  return body as T;
}

export type SettingsPayload = {
  botToken?: string;
  targetChannelId?: string;
  delayMinutes?: number;
  timezone?: string;
  paused?: boolean;
  queueRawOnFailure?: boolean;
  downloadMetadata?: boolean;
  postFooter?: string;
  /** `HH:MM`, or `''` to lift the restriction. Both ends travel together. */
  windowStart?: string;
  windowEnd?: string;
  watermarkEnabled?: boolean;
  watermarkRequired?: boolean;
  watermarkX?: number;
  watermarkY?: number;
  watermarkOpacity?: number;
  watermarkScale?: number;
};

type UsersResponse = { ok: boolean; users: User[] };

export const apiClient = {
  status: () => request<Status>('/status'),
  saveSettings: (payload: SettingsPayload) =>
    request<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  setPaused: (paused: boolean) =>
    request<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify({ paused }) }),
  restartBot: () => request<{ ok: boolean }>('/bot/restart', { method: 'POST' }),
  updateTools: () => request<Status & { ok: boolean }>('/tools/update', { method: 'POST' }),
  addUser: (telegramId: string, role: Role) =>
    request<UsersResponse>('/users', { method: 'POST', body: JSON.stringify({ telegramId, role }) }),
  setUserRole: (telegramId: string, role: Role) =>
    request<UsersResponse>(`/users/${telegramId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeUser: (telegramId: string) =>
    request<UsersResponse>(`/users/${telegramId}`, { method: 'DELETE' }),
  queue: () => request<{ count: number; items: QueueItem[] }>('/queue'),
  posts: () => request<{ count: number; items: PostRecord[] }>('/posts'),
  removeQueueItem: (id: number) => request<{ ok: boolean }>(`/queue/${id}`, { method: 'DELETE' }),
  clearQueue: () => request<{ ok: boolean; removed: number }>('/queue', { method: 'DELETE' }),
  postNow: () => request<{ ok: boolean; error?: string }>('/post-now', { method: 'POST' }),
  addChannel: (chatId: string) =>
    request<{ ok: boolean }>('/channels', { method: 'POST', body: JSON.stringify({ chatId }) }),
  uploadWatermark: (file: File) => uploadWatermark(file),
  /**
   * The preview cannot be an `<img src="/api/watermark">`: the dashboard
   * authenticates with a header, which a plain image request cannot carry. So
   * it is fetched like everything else and handed to the page as a blob URL,
   * which the caller revokes when it is done with it.
   */
  watermarkImageUrl: () => watermarkImageUrl(),
  removeWatermark: () => request<{ ok: boolean }>('/watermark', { method: 'DELETE' }),
};

async function uploadWatermark(file: File): Promise<{ ok: boolean; bytes: number }> {
  // Raw bytes, not JSON — base64 would inflate the PNG by a third for nothing.
  const response = await fetch('/api/watermark', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
    body: file,
  });

  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 413) throw new Error('That PNG is too large.');

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `Upload failed (${response.status})`));
  return body as { ok: boolean; bytes: number };
}

async function watermarkImageUrl(): Promise<string | null> {
  const response = await fetch('/api/watermark', { headers: authHeaders() });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

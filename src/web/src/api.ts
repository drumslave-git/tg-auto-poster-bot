import type { PostRecord, QueueItem, Status } from './types';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const password = getPassword();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(password ? { 'x-dashboard-password': password } : {}),
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
  adminId?: string;
  targetChannelId?: string;
  delayMinutes?: number;
  timezone?: string;
};

export const apiClient = {
  status: () => request<Status>('/status'),
  saveSettings: (payload: SettingsPayload) =>
    request<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  restartBot: () => request<{ ok: boolean }>('/bot/restart', { method: 'POST' }),
  queue: () => request<{ count: number; items: QueueItem[] }>('/queue'),
  posts: () => request<{ count: number; items: PostRecord[] }>('/posts'),
  removeQueueItem: (id: number) => request<{ ok: boolean }>(`/queue/${id}`, { method: 'DELETE' }),
  clearQueue: () => request<{ ok: boolean; removed: number }>('/queue', { method: 'DELETE' }),
  postNow: () => request<{ ok: boolean; error?: string }>('/post-now', { method: 'POST' }),
  addChannel: (chatId: string) =>
    request<{ ok: boolean }>('/channels', { method: 'POST', body: JSON.stringify({ chatId }) }),
};

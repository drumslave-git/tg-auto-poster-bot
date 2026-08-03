export type BotStatus = 'stopped' | 'starting' | 'running' | 'error';

export type Channel = {
  chatId: string;
  title: string | null;
  username: string | null;
  type: string;
  status: string;
  canPost: boolean;
  lastPostAt: number | null;
  updatedAt: number;
};

export type Role = 'admin' | 'manager';

export type User = {
  telegramId: string;
  role: Role;
  /** Name cached the last time this user messaged the bot. */
  label: string | null;
  createdAt: number;
  username: string | null;
  firstName: string | null;
};

export type QueueItem = {
  id: number;
  sourceChatId: string;
  messageIds: number[];
  kind: 'single' | 'album';
  contentType: string;
  preview: string;
  createdAt: number;
};

export type PostRecord = {
  id: number;
  channelId: string;
  messageIds: number[];
  contentType: string;
  preview: string;
  mode: 'auto' | 'manual';
  postedAt: number;
};

export type Status = {
  serverTime: string;
  authRequired: boolean;
  bot: {
    status: BotStatus;
    error: string | null;
    username: string | null;
    firstName: string | null;
    id: number | null;
  };
  users: User[];
  settings: {
    delayMinutes: number;
    timezone: string;
    targetChannelId: string | null;
    hasToken: boolean;
    tokenMask: string | null;
  };
  channels: Channel[];
  stats: {
    queueCount: number;
    postedCount: number;
    lastPostAt: string | null;
    nextPostAt: string | null;
    msRemaining: number;
    dueNow: boolean;
    blocked: string | null;
    targetChannelId: string | null;
    targetChannelTitle: string | null;
    runwayMs: number;
    queueEmptiesAt: string | null;
  };
  scheduler: { running: boolean; lastTickAt: string | null; lastError: string | null };
};

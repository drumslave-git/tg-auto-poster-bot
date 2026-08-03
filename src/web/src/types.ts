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

/**
 * Queued and published posts are one table on the server; a post keeps its row
 * and gains the channel columns when it goes out.
 */
type PostBase = {
  id: number;
  sourceChatId: string;
  sourceMessageIds: number[];
  kind: 'single' | 'album';
  contentType: string;
  preview: string;
  createdAt: number;
};

export type QueueItem = PostBase & { postedAt: null };

export type PostRecord = PostBase & {
  channelId: string;
  channelMessageIds: number[];
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
    paused: boolean;
    hasToken: boolean;
    tokenMask: string | null;
  };
  channels: Channel[];
  queue: QueueItem[];
  stats: {
    queueCount: number;
    postedCount: number;
    lastPostAt: string | null;
    nextPostAt: string | null;
    msRemaining: number;
    dueNow: boolean;
    paused: boolean;
    blocked: string | null;
    targetChannelId: string | null;
    targetChannelTitle: string | null;
    runwayMs: number;
    queueEmptiesAt: string | null;
  };
  scheduler: { running: boolean; lastTickAt: string | null; lastError: string | null };
  tools: Tools;
};

export type ToolStatus = {
  version: string | null;
  /** Why the tool is unusable, or null when it answered. */
  error: string | null;
};

export type UpdateOutcome = 'updated' | 'up-to-date' | 'unsupported' | 'failed';

/** yt-dlp and ffmpeg — the pair that turns a link into a post. */
export type Tools = {
  ytDlp: ToolStatus;
  ffmpeg: ToolStatus;
  checkedAt: string | null;
  updating: boolean;
  nextCheckAt: string | null;
  lastUpdate: { at: string; outcome: UpdateOutcome; message: string } | null;
};

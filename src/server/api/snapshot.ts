import { botManager } from '../bot/manager.js';
import { schedulerState } from '../bot/scheduler.js';
import { env } from '../env.js';
import { listChannels } from '../services/channels.js';
import { getSchedule } from '../services/poster.js';
import { usersWithProfiles } from '../services/profiles.js';
import { listQueue, postedCount } from '../services/queue.js';
import { getSettings } from '../services/settings.js';
import { toolsState } from '../services/tools.js';
import { authRequired } from './auth.js';

export function maskToken(token: string | null): string | null {
  if (!token) return null;
  const [id] = token.split(':');
  return `${id ?? ''}:${'•'.repeat(8)}${token.slice(-4)}`;
}

/**
 * Everything the dashboard renders, in one object. `GET /status` answers with
 * it and the SSE stream pushes it, so the two can never drift apart.
 */
export async function buildSnapshot() {
  const settings = getSettings();
  const schedule = getSchedule();
  const pending = schedule.queueCount;
  const runwayMs = pending * settings.delayMinutes * 60_000;
  const users = await usersWithProfiles();
  const botState = botManager.getState();
  const tools = toolsState();

  return {
    version: env.version,
    serverTime: new Date().toISOString(),
    authRequired: authRequired(),
    bot: {
      status: botState.status,
      error: botState.error,
      username: botState.info?.username ?? null,
      firstName: botState.info?.first_name ?? null,
      id: botState.info?.id ?? null,
    },
    users,
    settings: {
      delayMinutes: settings.delayMinutes,
      timezone: settings.timezone,
      targetChannelId: settings.targetChannelId,
      paused: settings.paused,
      hasToken: Boolean(settings.botToken),
      tokenMask: maskToken(settings.botToken),
    },
    channels: listChannels(),
    queue: listQueue(),
    stats: {
      queueCount: pending,
      postedCount: postedCount(),
      lastPostAt: schedule.lastPostAt?.toISOString() ?? null,
      nextPostAt: schedule.nextPostAt?.toISOString() ?? null,
      msRemaining: schedule.msRemaining,
      dueNow: schedule.dueNow,
      paused: schedule.paused,
      blocked: schedule.blocked,
      targetChannelId: schedule.targetChannelId,
      targetChannelTitle: schedule.targetChannelTitle,
      runwayMs,
      queueEmptiesAt:
        schedule.nextPostAt && pending > 0
          ? new Date(
              schedule.nextPostAt.getTime() + (pending - 1) * settings.delayMinutes * 60_000,
            ).toISOString()
          : null,
    },
    scheduler: schedulerState(),
    /** The yt-dlp / ffmpeg pair that turns a link into a post. */
    tools: {
      ytDlp: tools.ytDlp,
      ffmpeg: tools.ffmpeg,
      checkedAt: tools.checkedAt?.toISOString() ?? null,
      updating: tools.updating,
      nextCheckAt: tools.nextCheckAt?.toISOString() ?? null,
      lastUpdate: tools.lastUpdate
        ? {
            at: tools.lastUpdate.at.toISOString(),
            outcome: tools.lastUpdate.outcome,
            message: tools.lastUpdate.message,
          }
        : null,
    },
  };
}

export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;

import { getSchedule, postNext, syncQueueHead } from '../services/poster.js';
import { queueCount } from '../services/queue.js';
import { botManager } from './manager.js';

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let lastTickAt: Date | null = null;

async function tick(): Promise<void> {
  lastTickAt = new Date();
  const api = botManager.getApi();
  if (!api) return;

  // Also re-marks the head after a restart or a change made outside the bot.
  await syncQueueHead(api);
  if (queueCount() === 0) return;

  const schedule = getSchedule();
  // Paused schedules are never due; the queue keeps filling in the meantime.
  if (!schedule.dueNow || !schedule.targetChannelId) return;

  const result = await postNext(api, 'auto');
  if (result.ok) {
    lastError = null;
    console.log(`[scheduler] posted ${result.contentType} to ${result.channelId}`);
  } else {
    lastError = result.error;
    console.warn(`[scheduler] skipped: ${result.error}`);
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick().catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('[scheduler] tick failed', error);
    });
  }, TICK_MS);
  // Don't wait a full minute after a restart.
  void tick().catch((error) => console.error('[scheduler] first tick failed', error));
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function schedulerState(): { running: boolean; lastTickAt: Date | null; lastError: string | null } {
  return { running: timer !== null, lastTickAt, lastError };
}

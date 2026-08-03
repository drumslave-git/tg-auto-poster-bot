import type { Request, Response } from 'express';
import { onDashboardChange } from '../events.js';
import { buildSnapshot, type Snapshot } from './snapshot.js';

/** A burst of changes (queue edit + head sync) collapses into one frame. */
const DEBOUNCE_MS = 120;
/**
 * Catches what nothing announced: a post appearing in the channel, or the
 * countdown falling due. Cheap — one snapshot for all connected dashboards.
 */
const REVALIDATE_MS = 5_000;
/** A quiet stream still sends this often, so idle connections are not dropped. */
const KEEPALIVE_MS = 25_000;

const clients = new Set<Response>();

let lastSignature = '';
let lastSentAt = 0;
let revalidateTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let sending = false;
let dirty = false;

function frame(snapshot: Snapshot): string {
  return `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

/**
 * What counts as a change. `serverTime` and `msRemaining` move on every build
 * and the countdown ticks locally from the last frame anyway — letting them
 * mark the snapshot dirty would turn the stream back into a 5 s poll.
 */
function signatureOf(snapshot: Snapshot): string {
  const { serverTime: _serverTime, stats, ...rest } = snapshot;
  const { msRemaining: _msRemaining, ...stableStats } = stats;
  return JSON.stringify({ ...rest, stats: stableStats });
}

/** Sends the current state to every client, unless nothing has changed. */
async function publish(): Promise<void> {
  if (clients.size === 0) return;
  if (sending) {
    // A change arrived while we were building; re-run once this pass is done.
    dirty = true;
    return;
  }

  sending = true;
  try {
    do {
      dirty = false;
      const snapshot = await buildSnapshot();
      const signature = signatureOf(snapshot);
      if (signature === lastSignature && Date.now() - lastSentAt < KEEPALIVE_MS) continue;

      lastSignature = signature;
      lastSentAt = Date.now();
      const payload = frame(snapshot);
      for (const client of clients) client.write(payload);
    } while (dirty);
  } catch (error) {
    console.error('[stream] could not build the dashboard snapshot', error);
  } finally {
    sending = false;
  }
}

function scheduleBroadcast(): void {
  if (clients.size === 0 || debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void publish();
  }, DEBOUNCE_MS);
  debounceTimer.unref();
}

function startRevalidating(): void {
  if (revalidateTimer) return;
  revalidateTimer = setInterval(() => void publish(), REVALIDATE_MS);
  revalidateTimer.unref();
}

function stopRevalidating(): void {
  if (!revalidateTimer) return;
  clearInterval(revalidateTimer);
  revalidateTimer = null;
}

/** `GET /api/events` — one long-lived response per open dashboard. */
export async function streamState(req: Request, res: Response): Promise<void> {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx and friends buffer responses by default, which stalls the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);
  // The response never ends on its own; an idle-socket timeout would kill it.
  req.socket.setTimeout(0);
  // How soon a dropped client should come back.
  res.write('retry: 3000\n\n');

  clients.add(res);
  startRevalidating();

  const drop = () => {
    clients.delete(res);
    if (clients.size === 0) stopRevalidating();
  };
  res.on('close', drop);
  res.on('error', drop);

  try {
    const snapshot = await buildSnapshot();
    // The client may have gone away while we were building.
    if (!clients.has(res)) return;
    lastSignature = signatureOf(snapshot);
    lastSentAt = Date.now();
    res.write(frame(snapshot));
  } catch (error) {
    console.error('[stream] initial snapshot failed', error);
    if (clients.has(res)) res.write('event: error\ndata: {"error":"Snapshot failed"}\n\n');
  }
}

/** Lets `server.close()` finish — open streams would otherwise hold it open. */
export function closeStreams(): void {
  for (const client of clients) client.end();
  clients.clear();
  stopRevalidating();
}

onDashboardChange(scheduleBroadcast);

import { authHeaders } from './api';
import type { Status } from './types';

export type StreamHandlers = {
  /** A fresh snapshot of everything the dashboard shows. */
  onState: (state: Status) => void;
  onOpen: () => void;
  /** The stream is gone; a reconnect is already scheduled. */
  onDown: (message: string) => void;
  onUnauthorized: () => void;
};

/** Backoff between reconnects, in ms; the last value repeats. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

/**
 * Subscribes to `GET /api/events`.
 *
 * Server-sent events read through `fetch` rather than `EventSource`, because
 * EventSource cannot set the `x-dashboard-password` header and passing the
 * password in the query string would leak it into logs and browser history.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToState(handlers: StreamHandlers): () => void {
  const controller = new AbortController();
  let stopped = false;
  /** Set while waiting to reconnect — calling it retries straight away. */
  let wake: (() => void) | null = null;

  function retryNow(): void {
    wake?.();
  }

  function pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener('abort', done);
      wake = done;
    });
  }

  async function run(): Promise<void> {
    let attempt = 0;

    while (!stopped) {
      try {
        const response = await fetch('/api/events', {
          headers: { Accept: 'text/event-stream', ...authHeaders() },
          cache: 'no-store',
          signal: controller.signal,
        });

        if (response.status === 401) {
          handlers.onUnauthorized();
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Live updates unavailable (${response.status})`);
        }

        attempt = 0;
        handlers.onOpen();
        await readEvents(response.body, (event, data) => {
          if (event === 'state') handlers.onState(JSON.parse(data) as Status);
        });
        if (stopped) return;
        handlers.onDown('Live connection dropped — reconnecting…');
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        handlers.onDown(
          error instanceof Error ? error.message : 'Could not reach the server — reconnecting…',
        );
      }

      await pause(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
      attempt += 1;
    }
  }

  // A backgrounded tab may have had its stream cut; don't sit out the backoff.
  const onVisible = () => {
    if (document.visibilityState === 'visible') retryNow();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', retryNow);

  void run();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', retryNow);
    controller.abort();
  };
}

/** Resolves when the stream ends. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });
    // A blank line ends a frame; whatever follows it is still incomplete.
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = parseFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (frame) onEvent(frame.event, frame.data);
      end = buffer.indexOf('\n\n');
    }
  }
}

function parseFrame(chunk: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];

  for (const line of chunk.split('\n')) {
    // Empty lines and `:` comments (keep-alives) carry nothing.
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

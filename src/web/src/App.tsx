import { useCallback, useEffect, useState } from 'react';
import { apiClient, UnauthorizedError } from './api';
import { ChannelsPanel } from './components/ChannelsPanel';
import { Countdown } from './components/Countdown';
import { PasswordGate } from './components/PasswordGate';
import { QueuePanel } from './components/QueuePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ToolsPanel } from './components/ToolsPanel';
import { UsersPanel } from './components/UsersPanel';
import { Badge, Button, Stat } from './components/ui';
import { subscribeToState } from './events';
import { formatDateTime, formatRunway } from './format';
import type { BotStatus, Status } from './types';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const BOT_TONE: Record<BotStatus, 'green' | 'amber' | 'red' | 'slate'> = {
  running: 'green',
  starting: 'amber',
  error: 'red',
  stopped: 'slate',
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the live stream is not connected, or null while it is. */
  const [offline, setOffline] = useState<string | null>('Connecting…');
  /** Bumped to re-open the stream, e.g. after the password was entered. */
  const [session, setSession] = useState(0);
  const [pausing, setPausing] = useState(false);

  // The server pushes a new snapshot on every change; this is only for the
  // instant feedback after an action, and as a fallback while the stream is down.
  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.status();
      setStatus(next);
      setLocked(false);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setLocked(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    }
  }, []);

  useEffect(
    () =>
      subscribeToState({
        onState: (next) => {
          setStatus(next);
          setLocked(false);
        },
        onOpen: () => setOffline(null),
        onDown: (message) => setOffline(message),
        onUnauthorized: () => {
          setOffline(null);
          setLocked(true);
        },
      }),
    [session],
  );

  const togglePaused = useCallback(
    async (paused: boolean) => {
      setPausing(true);
      setError(null);
      try {
        await apiClient.setPaused(paused);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not change the paused state');
      } finally {
        setPausing(false);
      }
    },
    [refresh],
  );

  if (locked) {
    return (
      <PasswordGate
        onSubmit={() => {
          setLocked(false);
          setSession((value) => value + 1);
        }}
      />
    );
  }

  if (!status) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-slate-500">
        {error ?? offline ?? 'Loading…'}
      </div>
    );
  }

  const { bot, users, stats, settings, scheduler } = status;
  const adminCount = users.filter((user) => user.role === 'admin').length;
  const managerCount = users.length - adminCount;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Telegram auto-poster</h1>
          <p className="text-sm text-slate-500">
            Publishes one queued post every {settings.delayMinutes} min of channel silence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={BOT_TONE[bot.status]}>
            {bot.status === 'running' ? `@${bot.username}` : bot.status}
          </Badge>
          <Badge tone={settings.paused ? 'amber' : scheduler.running ? 'green' : 'red'}>
            {settings.paused ? 'paused' : `scheduler ${scheduler.running ? 'on' : 'off'}`}
          </Badge>
          {offline && <Badge tone="amber">reconnecting…</Badge>}
          <Button
            variant={settings.paused ? 'primary' : 'ghost'}
            disabled={pausing}
            onClick={() => void togglePaused(!settings.paused)}
          >
            {settings.paused ? '▶ Resume posting' : '⏸ Pause posting'}
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-xl border border-rose-900 bg-rose-950/50 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      {bot.error && (
        <p className="rounded-xl border border-rose-900 bg-rose-950/50 px-4 py-2 text-sm text-rose-300">
          Bot: {bot.error}
        </p>
      )}
      {scheduler.lastError && (
        <p className="rounded-xl border border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
          Last scheduler run: {scheduler.lastError}
        </p>
      )}
      {status.tools.ytDlp.error && (
        <p className="rounded-xl border border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
          yt-dlp: {status.tools.ytDlp.error} Links stay un-postable until it is installed.
        </p>
      )}

      <Countdown status={status} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Bot"
          value={bot.username ? `@${bot.username}` : '—'}
          hint={bot.firstName ?? (settings.hasToken ? 'token set' : 'no token')}
        />
        <Stat
          label="People"
          value={users.length}
          hint={
            users.length === 0
              ? 'add an admin below'
              : `${plural(adminCount, 'admin')} · ${plural(managerCount, 'manager')}`
          }
        />
        <Stat
          label="In queue"
          value={stats.queueCount}
          hint={stats.queueCount === 0 ? 'nothing scheduled' : `${formatRunway(stats.runwayMs)} of content`}
        />
        <Stat
          label="Posted"
          value={stats.postedCount}
          hint={`channel activity ${formatDateTime(stats.lastPostAt, settings.timezone)}`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Channel"
          value={stats.targetChannelTitle ?? '—'}
          hint={stats.targetChannelId ?? 'no target'}
        />
        <Stat
          label="Delay"
          value={`${settings.delayMinutes} min`}
          hint={
            stats.window
              ? `${stats.window.start}–${stats.window.end} · ${settings.timezone}`
              : settings.timezone
          }
        />
        <Stat
          label="Next post"
          value={settings.paused ? 'Paused' : formatDateTime(stats.nextPostAt, settings.timezone)}
          hint={settings.paused ? 'resume to schedule' : stats.dueNow ? 'due now' : 'scheduled'}
        />
        <Stat
          label="Queue empties"
          value={formatDateTime(stats.queueEmptiesAt, settings.timezone)}
          hint="at the current delay"
        />
      </div>

      <QueuePanel status={status} onChanged={() => void refresh()} />
      <SettingsPanel status={status} onSaved={() => void refresh()} />
      <UsersPanel status={status} onChanged={() => void refresh()} />
      <ChannelsPanel status={status} onChanged={() => void refresh()} />
      <ToolsPanel status={status} onChanged={() => void refresh()} />

      <footer className="pb-6 text-center text-xs text-slate-600">
        v{status.version} · Server time {formatDateTime(status.serverTime, settings.timezone)} ·{' '}
        {settings.timezone}
      </footer>
    </div>
  );
}

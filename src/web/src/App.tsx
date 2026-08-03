import { useCallback, useEffect, useState } from 'react';
import { apiClient, UnauthorizedError } from './api';
import { ChannelsPanel } from './components/ChannelsPanel';
import { Countdown } from './components/Countdown';
import { PasswordGate } from './components/PasswordGate';
import { QueuePanel } from './components/QueuePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Badge, Stat } from './components/ui';
import { formatDateTime, formatRunway } from './format';
import type { BotStatus, Status } from './types';

const POLL_MS = 5000;

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
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.status();
      setStatus(next);
      setLocked(false);
      setError(null);
      setTick((value) => value + 1);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setLocked(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (locked) return <PasswordGate onSubmit={() => void refresh()} />;

  if (!status) {
    return (
      <div className="flex min-h-full items-center justify-center text-sm text-slate-500">
        {error ?? 'Loading…'}
      </div>
    );
  }

  const { bot, admin, stats, settings, scheduler } = status;
  const adminLabel = admin
    ? (admin.username ? `@${admin.username}` : (admin.firstName ?? admin.id))
    : 'not set';

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
          <Badge tone={scheduler.running ? 'green' : 'red'}>
            scheduler {scheduler.running ? 'on' : 'off'}
          </Badge>
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

      <Countdown status={status} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Bot"
          value={bot.username ? `@${bot.username}` : '—'}
          hint={bot.firstName ?? (settings.hasToken ? 'token set' : 'no token')}
        />
        <Stat label="Admin" value={adminLabel} hint={admin ? `id ${admin.id}` : 'set an admin id'} />
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
        <Stat label="Delay" value={`${settings.delayMinutes} min`} hint={settings.timezone} />
        <Stat
          label="Next post"
          value={formatDateTime(stats.nextPostAt, settings.timezone)}
          hint={stats.dueNow ? 'due now' : 'scheduled'}
        />
        <Stat
          label="Queue empties"
          value={formatDateTime(stats.queueEmptiesAt, settings.timezone)}
          hint="at the current delay"
        />
      </div>

      <QueuePanel status={status} refreshToken={tick} onChanged={() => void refresh()} />
      <SettingsPanel status={status} onSaved={() => void refresh()} />
      <ChannelsPanel status={status} onChanged={() => void refresh()} />

      <footer className="pb-6 text-center text-xs text-slate-600">
        Server time {formatDateTime(status.serverTime, settings.timezone)} · {settings.timezone}
      </footer>
    </div>
  );
}

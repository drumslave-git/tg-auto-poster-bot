import { useState } from 'react';
import { apiClient } from '../api';
import { formatDateTime } from '../format';
import type { Status } from '../types';
import { Badge, Button, Card, Empty, inputClass } from './ui';

function statusTone(status: string) {
  if (status === 'administrator' || status === 'creator') return 'green' as const;
  if (status === 'left' || status === 'kicked') return 'red' as const;
  return 'amber' as const;
}

export function ChannelsPanel({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!chatId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.addChannel(chatId.trim());
      setChatId('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add channel');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Channels (${status.channels.length})`}>
      {status.channels.length === 0 ? (
        <Empty>
          Add the bot to a channel as an administrator with “Post messages”. It shows up here
          automatically.
        </Empty>
      ) : (
        <ul className="divide-y divide-slate-800">
          {status.channels.map((channel) => {
            const isTarget = channel.chatId === status.stats.targetChannelId;
            return (
              <li key={channel.chatId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-100">
                      {channel.title ?? channel.chatId}
                    </span>
                    {isTarget && <Badge tone="sky">target</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
                    {channel.username ? `@${channel.username} · ` : ''}
                    {channel.chatId} · last message{' '}
                    {formatDateTime(channel.lastPostAt, status.settings.timezone)}
                  </div>
                </div>
                <Badge tone={statusTone(channel.status)}>{channel.status}</Badge>
              </li>
            );
          })}
        </ul>
      )}

      <form className="mt-4 flex gap-2 border-t border-slate-800 pt-4" onSubmit={add}>
        <input
          className={inputClass}
          placeholder="@channelname or -1001234567890"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
        />
        <Button type="submit" disabled={busy || status.bot.status !== 'running'}>
          Add
        </Button>
      </form>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </Card>
  );
}

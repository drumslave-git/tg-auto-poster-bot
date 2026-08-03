import { useState } from 'react';
import { apiClient } from '../api';
import { formatDateTime, typeIcon } from '../format';
import type { Status } from '../types';
import { Button, Card, Empty } from './ui';

export function QueuePanel({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Part of the pushed snapshot, so the list updates itself.
  const items = status.queue;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const canPost = status.bot.status === 'running' && status.stats.queueCount > 0;

  return (
    <Card
      title={`Queue (${status.stats.queueCount})`}
      actions={
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy || !canPost} onClick={() => void run(async () => {
            const result = await apiClient.postNow();
            if (!result.ok) throw new Error(result.error ?? 'Post failed');
          })}>
            Post next now
          </Button>
          <Button
            variant="danger"
            disabled={busy || status.stats.queueCount === 0}
            onClick={() => {
              if (confirm(`Delete all ${status.stats.queueCount} queued posts?`)) {
                void run(() => apiClient.clearQueue());
              }
            }}
          >
            Clear
          </Button>
        </div>
      }
    >
      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      {items.length === 0 ? (
        <Empty>Nothing queued. Send the bot a message and it lands here.</Empty>
      ) : (
        <ol className="divide-y divide-slate-800">
          {items.map((item, index) => (
            <li key={item.id} className="flex items-start gap-3 py-3">
              <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-slate-600">
                {index + 1}
              </span>
              <span className="shrink-0 text-lg" aria-hidden>
                {typeIcon(item.contentType)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-200">
                  {item.preview || <span className="text-slate-500">({item.contentType})</span>}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {item.contentType}
                  {item.sourceMessageIds.length > 1
                    ? ` · ${item.sourceMessageIds.length} items`
                    : ''}{' '}
                  · added {formatDateTime(item.createdAt, status.settings.timezone)}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() => void run(() => apiClient.removeQueueItem(item.id))}
                aria-label={`Remove item ${index + 1}`}
              >
                ✕
              </Button>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

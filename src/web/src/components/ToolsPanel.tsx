import { useState } from 'react';
import { apiClient } from '../api';
import { formatDateTime } from '../format';
import type { Status, ToolStatus, UpdateOutcome } from '../types';
import { Badge, Button, Card } from './ui';

const OUTCOME_TONE: Record<UpdateOutcome, 'green' | 'sky' | 'amber' | 'red'> = {
  updated: 'green',
  'up-to-date': 'sky',
  unsupported: 'amber',
  failed: 'red',
};

function ToolRow({ name, note, tool }: { name: string; note: string; tool: ToolStatus }) {
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="font-medium text-slate-100">{name}</div>
        <div className={`mt-0.5 text-xs ${tool.error ? 'text-rose-400' : 'text-slate-500'}`}>
          {tool.error ?? note}
        </div>
      </div>
      {tool.version ? (
        <Badge tone="green">
          <span className="font-mono">{tool.version}</span>
        </Badge>
      ) : (
        <Badge tone="red">missing</Badge>
      )}
    </li>
  );
}

/**
 * yt-dlp and ffmpeg: what they are, which version is installed, and a way to
 * run the yt-dlp updater without waiting for the daily check.
 */
export function ToolsPanel({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const { tools, settings } = status;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updating = busy || tools.updating;

  async function update() {
    setBusy(true);
    setError(null);
    try {
      await apiClient.updateTools();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run the update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Media tools"
      actions={
        <Button disabled={updating} onClick={() => void update()}>
          {updating ? 'Updating…' : 'Update now'}
        </Button>
      }
    >
      <ul className="divide-y divide-slate-800">
        <ToolRow
          name="yt-dlp"
          note="Downloads the media behind a link. Checked and updated once a day."
          tool={tools.ytDlp}
        />
        <ToolRow
          name="ffmpeg"
          note="Merges the separate video and audio streams. Ships with the image; pull a newer image to move it forward."
          tool={tools.ffmpeg}
        />
      </ul>

      <div className="mt-4 space-y-2 border-t border-slate-800 pt-4 text-xs text-slate-500">
        <p>
          Versions read {formatDateTime(tools.checkedAt, settings.timezone)}
          {tools.nextCheckAt
            ? ` · next check ${formatDateTime(tools.nextCheckAt, settings.timezone)}`
            : ''}
        </p>
        {tools.lastUpdate && (
          <div className="flex items-start gap-2">
            <Badge tone={OUTCOME_TONE[tools.lastUpdate.outcome]}>{tools.lastUpdate.outcome}</Badge>
            <span>
              {tools.lastUpdate.message} ({formatDateTime(tools.lastUpdate.at, settings.timezone)})
            </span>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </Card>
  );
}

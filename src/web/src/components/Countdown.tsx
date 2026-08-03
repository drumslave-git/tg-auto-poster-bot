import { useEffect, useState } from 'react';
import { formatDuration } from '../format';
import type { Status } from '../types';

/**
 * Ticks locally between polls. The baseline is the server's msRemaining, so a
 * clock offset between browser and server never shows up in the countdown.
 */
export function Countdown({ status }: { status: Status }) {
  const { stats, settings } = status;
  const [remaining, setRemaining] = useState(stats.msRemaining);

  useEffect(() => {
    const receivedAt = Date.now();
    setRemaining(stats.msRemaining);
    const id = setInterval(() => {
      setRemaining(Math.max(0, stats.msRemaining - (Date.now() - receivedAt)));
    }, 1000);
    return () => clearInterval(id);
  }, [stats.msRemaining, stats.nextPostAt]);

  const idle = stats.queueCount === 0;
  const blocked = Boolean(stats.blocked) && !idle;
  const due = !idle && !blocked && remaining <= 0;

  return (
    <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/40 p-6">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        Next automatic post
      </div>
      <div
        className={`mt-2 font-mono text-5xl font-semibold tabular-nums sm:text-6xl ${
          idle || blocked ? 'text-slate-600' : due ? 'text-emerald-400' : 'text-slate-100'
        }`}
      >
        {idle || blocked ? '--:--:--' : formatDuration(remaining)}
      </div>
      <div className="mt-2 text-sm text-slate-400">
        {idle
          ? 'Queue is empty — send the bot something to post.'
          : blocked
            ? stats.blocked
            : due
              ? 'Due now — publishing on the next check.'
              : `Every ${settings.delayMinutes} min after the last message in ${
                  stats.targetChannelTitle ?? 'the channel'
                }`}
      </div>
    </div>
  );
}

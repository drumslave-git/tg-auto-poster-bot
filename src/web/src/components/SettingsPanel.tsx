import { useEffect, useMemo, useState } from 'react';
import { apiClient, type SettingsPayload } from '../api';
import type { Status } from '../types';
import { Button, Card, Field, inputClass } from './ui';

function timezoneOptions(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported === 'function') return supported('timeZone');
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Kyiv', 'America/New_York', 'Asia/Tokyo'];
}

export function SettingsPanel({ status, onSaved }: { status: Status; onSaved: () => void }) {
  const { settings, channels } = status;
  const [token, setToken] = useState('');
  const [delay, setDelay] = useState(String(settings.delayMinutes));
  const [timezone, setTimezone] = useState(settings.timezone);
  const [target, setTarget] = useState(settings.targetChannelId ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // Adopt server values when they change underneath us (e.g. /delay from chat).
  useEffect(() => setDelay(String(settings.delayMinutes)), [settings.delayMinutes]);
  useEffect(() => setTimezone(settings.timezone), [settings.timezone]);
  useEffect(() => setTarget(settings.targetChannelId ?? ''), [settings.targetChannelId]);

  const zones = useMemo(timezoneOptions, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const payload: SettingsPayload = {
      delayMinutes: Number(delay),
      timezone: timezone.trim(),
      targetChannelId: target,
    };
    // Only send the token when the user actually typed a new one.
    if (token.trim()) payload.botToken = token.trim();

    try {
      await apiClient.saveSettings(payload);
      setToken('');
      setMessage({ tone: 'ok', text: 'Saved.' });
      onSaved();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    try {
      await apiClient.restartBot();
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Configuration"
      actions={
        <Button type="button" onClick={restart} disabled={busy || !settings.hasToken}>
          Restart bot
        </Button>
      }
    >
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={save}>
        <div className="sm:col-span-2">
          <Field
            label="Bot token"
            hint={
              settings.hasToken
                ? `Stored as ${settings.tokenMask}. Leave blank to keep it.`
                : 'From @BotFather. Saving restarts the bot.'
            }
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              placeholder={settings.hasToken ? '•••••••• (unchanged)' : '123456789:AA…'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Delay (minutes)" hint="Time since the last message in the channel.">
          <input
            className={inputClass}
            type="number"
            min={1}
            max={43200}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
          />
        </Field>

        <Field label="Time zone" hint="Used for every time shown here and in chat.">
          <input
            className={inputClass}
            list="timezones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <datalist id="timezones">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </Field>

        <Field
          label="Target channel"
          hint={channels.length === 0 ? 'No channels known yet — add the bot to one.' : undefined}
        >
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Auto (single channel)</option>
            {channels.map((channel) => (
              <option key={channel.chatId} value={channel.chatId}>
                {channel.title ?? channel.chatId}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
          {message && (
            <span className={message.tone === 'ok' ? 'text-sm text-emerald-400' : 'text-sm text-rose-400'}>
              {message.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

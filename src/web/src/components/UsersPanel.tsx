import { useState } from 'react';
import { apiClient } from '../api';
import type { Role, Status, User } from '../types';
import { Badge, Button, Card, Empty, inputClass } from './ui';

const ROLE_HINT: Record<Role, string> = {
  admin: 'Full control: settings, delay, publish, clear queue.',
  manager: 'May only add posts to the queue.',
};

function displayName(user: User): string {
  if (user.username) return `@${user.username}`;
  return user.firstName ?? user.label ?? user.telegramId;
}

export function UsersPanel({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const { users } = status;
  const [telegramId, setTelegramId] = useState('');
  const [role, setRole] = useState<Role>('manager');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adminCount = users.filter((user) => user.role === 'admin').length;

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const id = telegramId.trim();
    if (!id) return;
    await run('add', async () => {
      await apiClient.addUser(id, role);
      setTelegramId('');
    });
  }

  return (
    <Card title={`People (${users.length})`}>
      {users.length === 0 ? (
        <Empty>
          Nobody can use the bot yet. Message it on Telegram — it replies with your user ID — then
          add that ID here as an admin.
        </Empty>
      ) : (
        <ul className="divide-y divide-slate-800">
          {users.map((user) => {
            const isLastAdmin = user.role === 'admin' && adminCount === 1;
            const rowBusy = busy === user.telegramId;
            return (
              <li key={user.telegramId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-slate-100">{displayName(user)}</span>
                    <Badge tone={user.role === 'admin' ? 'sky' : 'slate'}>{user.role}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
                    id {user.telegramId}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <select
                    className="rounded-lg border border-slate-700 bg-slate-950/80 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:text-slate-500"
                    value={user.role}
                    disabled={rowBusy || isLastAdmin}
                    title={isLastAdmin ? 'The last admin cannot be demoted.' : undefined}
                    onChange={(e) =>
                      void run(user.telegramId, () =>
                        apiClient.setUserRole(user.telegramId, e.target.value as Role),
                      )
                    }
                  >
                    <option value="admin">admin</option>
                    <option value="manager">manager</option>
                  </select>
                  <Button
                    variant="danger"
                    disabled={rowBusy || isLastAdmin}
                    title={isLastAdmin ? 'The last admin cannot be removed.' : undefined}
                    onClick={() =>
                      void run(user.telegramId, () => apiClient.removeUser(user.telegramId))
                    }
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form className="mt-4 flex flex-wrap gap-2 border-t border-slate-800 pt-4" onSubmit={add}>
        <input
          className={`${inputClass} min-w-40 flex-1`}
          inputMode="numeric"
          placeholder="Telegram user ID, e.g. 123456789"
          value={telegramId}
          onChange={(e) => setTelegramId(e.target.value)}
        />
        <select
          className="rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="manager">manager</option>
          <option value="admin">admin</option>
        </select>
        <Button type="submit" disabled={busy === 'add'}>
          Add
        </Button>
      </form>

      <p className="mt-2 text-xs text-slate-500">{ROLE_HINT[role]}</p>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </Card>
  );
}

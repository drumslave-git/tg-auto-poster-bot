import { botManager } from '../bot/manager.js';
import { listUsers } from './users.js';

/** getChat is a network call; these profiles barely change. */
type Profile = { username?: string; firstName?: string } | null;

const profileCache = new Map<string, { at: number; value: Profile }>();
const PROFILE_TTL_MS = 5 * 60_000;

/** A different bot means different profile lookups. */
export function clearProfiles(): void {
  profileCache.clear();
}

export function forgetProfile(telegramId: string): void {
  profileCache.delete(telegramId);
}

export async function resolveProfile(telegramId: string): Promise<Profile> {
  const cached = profileCache.get(telegramId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.value;

  const api = botManager.getApi();
  if (!api) return cached?.value ?? null;

  let value: Profile = null;
  try {
    const chat = await api.getChat(telegramId);
    if (chat.type === 'private') value = { username: chat.username, firstName: chat.first_name };
  } catch {
    // Unknown until that user has messaged the bot — fall back to the cached label.
  }
  profileCache.set(telegramId, { at: Date.now(), value });
  return value;
}

/** Users with their live Telegram profile where we can get one. */
export async function usersWithProfiles() {
  const rows = listUsers();
  return Promise.all(
    rows.map(async (user) => {
      const profile = await resolveProfile(user.telegramId);
      return {
        telegramId: user.telegramId,
        role: user.role,
        label: user.label,
        createdAt: user.createdAt,
        username: profile?.username ?? null,
        firstName: profile?.firstName ?? null,
      };
    }),
  );
}

import { Router } from 'express';
import { botManager } from '../bot/manager.js';
import { upsertChannel } from '../services/channels.js';
import { postNext, syncQueueHead } from '../services/poster.js';
import { clearProfiles, forgetProfile, resolveProfile, usersWithProfiles } from '../services/profiles.js';
import {
  clearQueue,
  listQueue,
  postedCount,
  queueCount,
  recentPosts,
  removeQueueItem,
} from '../services/queue.js';
import {
  MAX_DELAY_MINUTES,
  MIN_DELAY_MINUTES,
  isValidTelegramId,
  isValidTimezone,
  updateSettings,
  type SettingsPatch,
} from '../services/settings.js';
import { updateTools } from '../services/tools.js';
import {
  ROLES,
  addUser,
  blocksLastAdmin,
  getUser,
  isRole,
  removeUser,
  setRole,
} from '../services/users.js';
import { buildSnapshot, maskToken } from './snapshot.js';
import { streamState } from './stream.js';

export const api = Router();

api.get('/status', async (_req, res) => {
  res.json(await buildSnapshot());
});

/**
 * Live dashboard: the same snapshot, pushed whenever it changes. Clients that
 * cannot hold the stream open keep working through `GET /status`.
 */
api.get('/events', streamState);

api.put('/settings', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  const errors: string[] = [];

  if ('delayMinutes' in body) {
    const value = Number(body.delayMinutes);
    if (!Number.isInteger(value) || value < MIN_DELAY_MINUTES || value > MAX_DELAY_MINUTES) {
      errors.push(`delayMinutes must be an integer between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES}`);
    } else {
      patch.delayMinutes = value;
    }
  }

  if ('timezone' in body) {
    const value = String(body.timezone ?? '').trim();
    if (!value || !isValidTimezone(value)) errors.push('timezone must be a valid IANA time zone');
    else patch.timezone = value;
  }

  if ('targetChannelId' in body) {
    const value = String(body.targetChannelId ?? '').trim();
    patch.targetChannelId = value || null;
  }

  if ('paused' in body) {
    if (typeof body.paused !== 'boolean') errors.push('paused must be a boolean');
    else patch.paused = body.paused;
  }

  // Absent means "leave unchanged"; empty string means "clear".
  let tokenChanged = false;
  if ('botToken' in body) {
    const value = String(body.botToken ?? '').trim();
    if (!value) {
      patch.botToken = null;
      tokenChanged = true;
    } else if (!/^\d+:[\w-]{20,}$/.test(value)) {
      errors.push('botToken does not look like a Telegram bot token');
    } else {
      patch.botToken = value;
      tokenChanged = true;
    }
  }

  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  const updated = updateSettings(patch);
  if (tokenChanged) {
    clearProfiles();
    await botManager.apply(updated.botToken);
  }

  res.json({
    ok: true,
    bot: botManager.getState(),
    settings: {
      delayMinutes: updated.delayMinutes,
      timezone: updated.timezone,
      targetChannelId: updated.targetChannelId,
      paused: updated.paused,
      hasToken: Boolean(updated.botToken),
      tokenMask: maskToken(updated.botToken),
    },
  });
});

// --- Users ------------------------------------------------------------------

api.get('/users', async (_req, res) => {
  res.json({ users: await usersWithProfiles() });
});

api.post('/users', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const telegramId = String(body.telegramId ?? '').trim();
  const role = body.role ?? 'manager';

  if (!isValidTelegramId(telegramId) || telegramId.startsWith('-')) {
    res.status(400).json({ error: 'telegramId must be a numeric Telegram user id' });
    return;
  }
  if (!isRole(role)) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    return;
  }
  if (getUser(telegramId)) {
    res.status(409).json({ error: 'That user is already on the list.' });
    return;
  }

  const profile = await resolveProfile(telegramId);
  const label = profile?.username ? `@${profile.username}` : (profile?.firstName ?? null);
  addUser(telegramId, role, label);

  res.json({ ok: true, users: await usersWithProfiles() });
});

api.patch('/users/:telegramId', async (req, res) => {
  const { telegramId } = req.params;
  const role = (req.body as Record<string, unknown> | undefined)?.role;

  if (!isRole(role)) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    return;
  }
  if (!getUser(telegramId)) {
    res.status(404).json({ error: 'No such user.' });
    return;
  }

  const blocked = blocksLastAdmin(telegramId, role);
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }

  setRole(telegramId, role);
  res.json({ ok: true, users: await usersWithProfiles() });
});

api.delete('/users/:telegramId', async (req, res) => {
  const { telegramId } = req.params;
  if (!getUser(telegramId)) {
    res.status(404).json({ error: 'No such user.' });
    return;
  }

  const blocked = blocksLastAdmin(telegramId, null);
  if (blocked) {
    res.status(409).json({ error: blocked });
    return;
  }

  removeUser(telegramId);
  forgetProfile(telegramId);
  res.json({ ok: true, users: await usersWithProfiles() });
});

/**
 * Runs the yt-dlp updater now instead of waiting for the daily check. The
 * response carries the fresh snapshot, so the dashboard needs no second call.
 */
api.post('/tools/update', async (_req, res) => {
  await updateTools();
  res.json({ ok: true, ...(await buildSnapshot()) });
});

api.post('/bot/restart', async (_req, res) => {
  const state = await botManager.restart();
  res.json({ ok: state.status === 'running', bot: state });
});

/** Re-mark the queue head after the dashboard changed the queue. */
async function syncHead(): Promise<void> {
  const botApi = botManager.getApi();
  if (botApi) await syncQueueHead(botApi);
}

api.get('/queue', (_req, res) => {
  res.json({ count: queueCount(), items: listQueue() });
});

api.delete('/queue', async (_req, res) => {
  const removed = clearQueue();
  await syncHead();
  res.json({ ok: true, removed });
});

api.delete('/queue/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const removed = removeQueueItem(id);
  if (removed) await syncHead();
  res.status(removed ? 200 : 404).json({ ok: removed });
});

api.post('/post-now', async (_req, res) => {
  const botApi = botManager.getApi();
  if (!botApi) {
    res.status(409).json({ error: 'Bot is not running.' });
    return;
  }
  const result = await postNext(botApi, 'manual');
  res.status(result.ok ? 200 : 409).json(result);
});

api.get('/posts', (_req, res) => {
  res.json({ count: postedCount(), items: recentPosts(20) });
});

/**
 * Telegram offers no "list my chats" API — channels appear on their own once
 * the bot is added or the first channel post arrives. This lets the dashboard
 * register one up front by id or @username.
 */
api.post('/channels', async (req, res) => {
  const raw = String((req.body as Record<string, unknown> | undefined)?.chatId ?? '').trim();
  if (!raw) {
    res.status(400).json({ error: 'chatId is required' });
    return;
  }

  const botApi = botManager.getApi();
  if (!botApi) {
    res.status(409).json({ error: 'Bot is not running.' });
    return;
  }

  try {
    const chat = await botApi.getChat(raw);
    if (chat.type === 'private') {
      res.status(400).json({ error: 'That is a private chat, not a channel.' });
      return;
    }
    const me = await botApi.getMe();
    const member = await botApi.getChatMember(chat.id, me.id);
    const canPost =
      member.status === 'creator' ||
      (member.status === 'administrator' && (member.can_post_messages ?? true));

    upsertChannel({
      chatId: String(chat.id),
      title: chat.title,
      username: chat.username ?? null,
      type: chat.type,
      status: member.status,
      canPost,
    });

    res.json({ ok: true, chatId: String(chat.id), title: chat.title, status: member.status, canPost });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

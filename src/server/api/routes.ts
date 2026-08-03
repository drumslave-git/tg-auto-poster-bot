import { Router } from 'express';
import { botManager } from '../bot/manager.js';
import { schedulerState } from '../bot/scheduler.js';
import { listChannels, upsertChannel } from '../services/channels.js';
import { getSchedule, postNext } from '../services/poster.js';
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
  getSettings,
  isValidTelegramId,
  isValidTimezone,
  updateSettings,
  type SettingsPatch,
} from '../services/settings.js';
import { authRequired } from './auth.js';

export const api = Router();

function maskToken(token: string | null): string | null {
  if (!token) return null;
  const [id] = token.split(':');
  return `${id ?? ''}:${'•'.repeat(8)}${token.slice(-4)}`;
}

/** getChat is a network call; the admin's profile barely changes. */
const adminCache = { id: '', at: 0, value: null as { username?: string; firstName?: string } | null };
const ADMIN_TTL_MS = 5 * 60_000;

async function resolveAdmin(adminId: string | null) {
  if (!adminId) return null;
  const api = botManager.getApi();
  if (!api) return null;
  if (adminCache.id === adminId && Date.now() - adminCache.at < ADMIN_TTL_MS) return adminCache.value;

  try {
    const chat = await api.getChat(adminId);
    const value =
      chat.type === 'private'
        ? { username: chat.username, firstName: chat.first_name }
        : { username: undefined, firstName: undefined };
    adminCache.id = adminId;
    adminCache.at = Date.now();
    adminCache.value = value;
    return value;
  } catch {
    adminCache.id = adminId;
    adminCache.at = Date.now();
    adminCache.value = null;
    return null;
  }
}

api.get('/status', async (_req, res) => {
  const settings = getSettings();
  const schedule = getSchedule();
  const pending = schedule.queueCount;
  const runwayMs = pending * settings.delayMinutes * 60_000;
  const admin = await resolveAdmin(settings.adminId);
  const botState = botManager.getState();

  res.json({
    serverTime: new Date().toISOString(),
    authRequired: authRequired(),
    bot: {
      status: botState.status,
      error: botState.error,
      username: botState.info?.username ?? null,
      firstName: botState.info?.first_name ?? null,
      id: botState.info?.id ?? null,
    },
    admin: settings.adminId ? { id: settings.adminId, ...admin } : null,
    settings: {
      adminId: settings.adminId,
      delayMinutes: settings.delayMinutes,
      timezone: settings.timezone,
      targetChannelId: settings.targetChannelId,
      hasToken: Boolean(settings.botToken),
      tokenMask: maskToken(settings.botToken),
    },
    channels: listChannels(),
    stats: {
      queueCount: pending,
      postedCount: postedCount(),
      lastPostAt: schedule.lastPostAt?.toISOString() ?? null,
      nextPostAt: schedule.nextPostAt?.toISOString() ?? null,
      msRemaining: schedule.msRemaining,
      dueNow: schedule.dueNow,
      blocked: schedule.blocked,
      targetChannelId: schedule.targetChannelId,
      targetChannelTitle: schedule.targetChannelTitle,
      runwayMs,
      queueEmptiesAt:
        schedule.nextPostAt && pending > 0
          ? new Date(
              schedule.nextPostAt.getTime() + (pending - 1) * settings.delayMinutes * 60_000,
            ).toISOString()
          : null,
    },
    scheduler: schedulerState(),
  });
});

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

  if ('adminId' in body) {
    const value = String(body.adminId ?? '').trim();
    if (!value) patch.adminId = null;
    else if (!isValidTelegramId(value)) errors.push('adminId must be a numeric Telegram user id');
    else patch.adminId = value;
  }

  if ('targetChannelId' in body) {
    const value = String(body.targetChannelId ?? '').trim();
    patch.targetChannelId = value || null;
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
    adminCache.id = '';
    await botManager.apply(updated.botToken);
  }

  res.json({
    ok: true,
    bot: botManager.getState(),
    settings: {
      adminId: updated.adminId,
      delayMinutes: updated.delayMinutes,
      timezone: updated.timezone,
      targetChannelId: updated.targetChannelId,
      hasToken: Boolean(updated.botToken),
      tokenMask: maskToken(updated.botToken),
    },
  });
});

api.post('/bot/restart', async (_req, res) => {
  const state = await botManager.restart();
  res.json({ ok: state.status === 'running', bot: state });
});

api.get('/queue', (_req, res) => {
  res.json({ count: queueCount(), items: listQueue() });
});

api.delete('/queue', (_req, res) => {
  res.json({ ok: true, removed: clearQueue() });
});

api.delete('/queue/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const removed = removeQueueItem(id);
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

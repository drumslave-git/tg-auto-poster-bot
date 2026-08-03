import express, { Router } from 'express';
import { syncCommandMenu } from '../bot/commands.js';
import { botManager } from '../bot/manager.js';
import { notifyDashboard } from '../events.js';
import {
  MAX_WATERMARK_IMAGE_BYTES,
  hasWatermarkImage,
  readWatermarkImage,
  removeWatermarkImage,
  saveWatermarkImage,
  watermarkImageProblem,
} from '../media/watermark.js';
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
  MAX_FOOTER_LENGTH,
  MIN_DELAY_MINUTES,
  WATERMARK_LIMITS,
  getSettings,
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
import { parseClock } from '../util/time.js';
import { buildSnapshot, settingsView } from './snapshot.js';
import { streamState } from './stream.js';

export const api = Router();

/**
 * One end of the posting window: `HH:MM`, or empty to clear it. Returns
 * `undefined` for "the request did not mention this one".
 */
function readClock(
  body: Record<string, unknown>,
  key: 'windowStart' | 'windowEnd',
  errors: string[],
): number | null | undefined {
  if (!(key in body)) return undefined;

  const raw = body[key];
  const value = raw === null ? '' : String(raw).trim();
  if (!value) return null;

  const minutes = parseClock(value);
  if (minutes === null) {
    errors.push(`${key} must be a time of day like 13:00`);
    return undefined;
  }
  return minutes;
}

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

  for (const key of [
    'paused',
    'queueRawOnFailure',
    'downloadMetadata',
    'watermarkEnabled',
    'watermarkRequired',
  ] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') errors.push(`${key} must be a boolean`);
    else patch[key] = body[key];
  }

  for (const [key, { min, max }] of Object.entries(WATERMARK_LIMITS)) {
    if (!(key in body)) continue;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
    } else {
      patch[key as keyof typeof WATERMARK_LIMITS] = value;
    }
  }

  if ('postFooter' in body) {
    const value = String(body.postFooter ?? '').trim();
    if (value.length > MAX_FOOTER_LENGTH) {
      errors.push(`postFooter must be at most ${MAX_FOOTER_LENGTH} characters`);
    } else {
      patch.postFooter = value || null;
    }
  }

  const windowStart = readClock(body, 'windowStart', errors);
  const windowEnd = readClock(body, 'windowEnd', errors);
  if (windowStart !== undefined) patch.windowStart = windowStart;
  if (windowEnd !== undefined) patch.windowEnd = windowEnd;

  // A window needs both ends. They are checked against what the row will hold
  // once patched, so sending only one of them still has to add up.
  if (errors.length === 0 && (windowStart !== undefined || windowEnd !== undefined)) {
    const current = getSettings();
    // `null` here means "clear it", so undefined is the only thing that falls
    // back to the stored value.
    const start = windowStart === undefined ? current.windowStart : windowStart;
    const end = windowEnd === undefined ? current.windowEnd : windowEnd;

    if ((start === null) !== (end === null)) {
      errors.push('windowStart and windowEnd must both be set, or both cleared');
    } else if (start !== null && start === end) {
      errors.push('windowStart and windowEnd must differ');
    }
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

  res.json({ ok: true, bot: botManager.getState(), settings: settingsView(updated) });
});

// --- Watermark image --------------------------------------------------------

/**
 * The PNG travels as raw bytes rather than JSON: base64 would inflate it by a
 * third, and the global 1 MB JSON limit is right for every other request here.
 * `type: () => true` claims whatever the browser labelled the upload.
 *
 * The limit here is only a backstop against something absurd — it is set above
 * the real ceiling on purpose, so that an upload a little too large is turned
 * away by `watermarkImageProblem` with a sentence a person can act on, rather
 * than by the body parser throwing.
 */
const watermarkUpload = express.raw({
  type: () => true,
  limit: MAX_WATERMARK_IMAGE_BYTES * 2,
});

api.get('/watermark', async (_req, res) => {
  if (!hasWatermarkImage()) {
    res.status(404).json({ error: 'No watermark image is configured.' });
    return;
  }
  // The dashboard fetches this to preview it, so it must not be cached past a
  // replacement — and it is small enough that re-reading it costs nothing.
  res.type('image/png').set('Cache-Control', 'no-store').send(await readWatermarkImage());
});

api.post('/watermark', watermarkUpload, async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const problem = watermarkImageProblem(bytes);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  await saveWatermarkImage(bytes);
  // hasImage lives in the snapshot, so every open dashboard should hear it.
  notifyDashboard();
  res.json({ ok: true, bytes: bytes.length });
});

api.delete('/watermark', async (_req, res) => {
  const removed = await removeWatermarkImage();
  if (removed) notifyDashboard();
  res.status(removed ? 200 : 404).json({ ok: removed });
});

// --- Users ------------------------------------------------------------------

/** A menu is per-user, so who is on the list — and as what — decides it. */
async function syncMenus(): Promise<void> {
  const botApi = botManager.getApi();
  if (botApi) await syncCommandMenu(botApi);
}

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
  await syncMenus();

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
  await syncMenus();
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
  await syncMenus();
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

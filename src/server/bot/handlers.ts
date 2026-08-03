import { Bot, type Context, InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import type { StampKind } from '../media/watermark.js';
import { upsertChannel, touchLastPost } from '../services/channels.js';
import { getSchedule, postNext, syncQueueHead } from '../services/poster.js';
import { clearQueue, enqueue, queueCount } from '../services/queue.js';
import {
  MAX_DELAY_MINUTES,
  MIN_DELAY_MINUTES,
  getSettings,
  setPaused,
  updateSettings,
} from '../services/settings.js';
import { getUser, hasNoUsers, roleOf, setLabel } from '../services/users.js';
import {
  contentTypeLabel,
  escapeHtml,
  formatBytes,
  formatDuration,
  formatInTimezone,
  truncate,
} from '../util/format.js';
import { bufferAlbumMessage } from './albumBuffer.js';
import { captureText, describe } from './capture.js';
import { ensureCommandMenu, helpLinesFor } from './commands.js';
import {
  MAX_DOWNLOAD_BYTES,
  type Download,
  type MediaKind,
  downloadCaption,
  downloadMedia,
  extractDownloadRequest,
} from './download.js';
import { stampDownloadedFile, stampForQueue } from './stamp.js';

const INTRO = [
  'Send me any message — text, photo, video, album, file — and it goes into the queue.',
  `Send a link and I download the media behind it (up to ${formatBytes(MAX_DOWNLOAD_BYTES)}) ` +
    'and queue that instead of the link. Write something alongside the link and ' +
    'it becomes the caption.',
].join('\n');

const ADMIN_HELP = [
  '<b>Auto-poster commands</b>',
  '',
  INTRO,
  '',
  ...helpLinesFor('admin'),
].join('\n');

const MANAGER_HELP = [
  '<b>Auto-poster commands</b>',
  '',
  INTRO,
  '',
  ...helpLinesFor('manager'),
  '',
  'You are a manager: you can add posts and check the schedule. Changing the ' +
    'delay, publishing early, pausing and clearing the queue are admin-only.',
].join('\n');

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

async function replySchedule(ctx: Context, prefix?: string): Promise<void> {
  const { timezone } = getSettings();
  const schedule = getSchedule();
  const lines: string[] = [];
  if (prefix) lines.push(prefix);

  if (schedule.blocked && schedule.queueCount === 0) {
    lines.push('Queue is empty — nothing scheduled.');
  } else if (!schedule.nextPostAt) {
    lines.push(`⚠️ ${schedule.blocked ?? 'Not scheduled.'}`);
  } else if (schedule.dueNow) {
    lines.push('Next post is due — publishing on the next check.');
  } else {
    lines.push(
      `Next post in <b>${formatDuration(schedule.msRemaining)}</b> ` +
        `(${escapeHtml(formatInTimezone(schedule.nextPostAt, timezone))}).`,
    );
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function queueMessages(ctx: Context, messages: Message[]): Promise<void> {
  const first = messages[0]!;
  const { contentType, preview } = describe(messages);
  const { text, entities } = captureText(messages);

  enqueue({
    sourceChatId: String(first.chat.id),
    sourceMessageIds: messages.map((m) => m.message_id),
    kind: messages.length > 1 ? 'album' : 'single',
    contentType,
    preview,
    sourceText: text,
    sourceEntities: entities,
  });

  await syncQueueHead(ctx.api);

  const size = queueCount();
  const label = contentTypeLabel(contentType);
  // Just the confirmation — /till and /summary are there for the schedule.
  await ctx.reply(`✅ Queued ${escapeHtml(label)} — <b>${size}</b> in queue.`, {
    parse_mode: 'HTML',
  });
}

/** So the whole exchange about a link hangs off the link itself. */
type ReplyTo = { reply_parameters: { message_id: number; allow_sending_without_reply: true } };

function replyTo(message: Message): ReplyTo {
  return {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  };
}

/** Only the three kinds that carry a picture can be stamped; the rest cannot. */
function stampKindOf(kind: MediaKind): StampKind | null {
  return kind === 'photo' || kind === 'video' || kind === 'animation' ? kind : null;
}

/**
 * Everything reaches the queue through here, so the watermark cannot be
 * side-stepped by sending an album instead of a photo. What actually gets
 * queued is the stamped copy the bot sent back, not the original.
 */
async function queueWithWatermark(ctx: Context, messages: Message[]): Promise<void> {
  const outcome = await stampForQueue(ctx.api, messages);

  if (outcome.status === 'stamped') {
    await queueMessages(ctx, outcome.messages);
    return;
  }

  if (outcome.status === 'failed') {
    await ctx.reply(
      `${
        outcome.required
          ? '⚠️ Nothing queued — this could not be watermarked.'
          : '⚠️ Queued without a watermark — it could not be stamped.'
      }\n\n<code>${escapeHtml(outcome.error)}</code>`,
      { parse_mode: 'HTML', ...replyTo(messages[0]!) },
    );
    // The watermark was made a condition of posting, so the post does not go on
    // without it. Nothing is queued and the sender still has their message.
    if (outcome.required) return;
  }

  await queueMessages(ctx, messages);
}

async function sendDownload(
  ctx: Context,
  message: Message,
  url: string,
  note: string,
  download: Download,
): Promise<Message> {
  const file = new InputFile(download.file);
  const caption = downloadCaption(download, url, note, getSettings().downloadMetadata);
  const options = {
    // A caption of `''` is not the same as none; Telegram wants the field gone.
    ...(caption ? { caption, parse_mode: 'HTML' as const } : {}),
    ...replyTo(message),
  };
  const { duration, width, height } = download;

  switch (download.kind) {
    case 'video':
      return ctx.replyWithVideo(file, {
        ...options,
        supports_streaming: true,
        ...(duration ? { duration } : {}),
        ...(width && height ? { width, height } : {}),
      });
    case 'animation':
      return ctx.replyWithAnimation(file, options);
    case 'audio':
      return ctx.replyWithAudio(file, { ...options, ...(duration ? { duration } : {}) });
    case 'photo':
      return ctx.replyWithPhoto(file, options);
    default:
      return ctx.replyWithDocument(file, options);
  }
}

async function reportDownloadFailure(
  ctx: Context,
  message: Message,
  error: string,
  queuingRaw = false,
): Promise<void> {
  const lead = queuingRaw
    ? '⚠️ I could not get media from that link — queueing your message as it is.'
    : '⚠️ Nothing queued — I could not get media from that link.';

  await ctx.reply(`${lead}\n\n<code>${escapeHtml(error)}</code>`, {
    parse_mode: 'HTML',
    ...replyTo(message),
  });
}

/**
 * A link is not the post — the media behind it is. We download it, reply to the
 * link with the file, and queue that reply; the link message itself is left out
 * of the queue entirely. Words sent with the link become the file's caption and
 * travel to the channel with it.
 */
async function handleLink(
  ctx: Context,
  message: Message,
  url: string,
  note: string,
): Promise<void> {
  const status = await ctx
    .reply('⏳ Downloading the media behind that link…', replyTo(message))
    .catch(() => null);

  const result = await downloadMedia(url);

  // Our own progress note; the link and the outcome are what stay in the chat.
  if (status) {
    await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => undefined);
  }

  // Falling back means the sender's message goes into the queue exactly as they
  // wrote it, link and all — a post nobody has to send twice.
  const queueRaw = getSettings().queueRawOnFailure;
  const giveUp = async (error: string): Promise<void> => {
    await reportDownloadFailure(ctx, message, error, queueRaw);
    if (queueRaw) await queueMessages(ctx, [message]);
  };

  if (!result.ok) {
    await giveUp(result.error);
    return;
  }

  // The file is already on disk, so stamping it costs one ffmpeg run and none
  // of the 20 MB ceiling that applies to media fetched back out of Telegram.
  const stamped = await stampDownloadedFile(
    result.download.file,
    stampKindOf(result.download.kind),
  );

  if (stamped && !stamped.ok) {
    // The download itself worked, so this is not a download failure and the
    // "queue it raw" fallback has nothing to do with it.
    if (stamped.required) {
      await result.cleanup().catch(() => undefined);
      await ctx.reply(
        `⚠️ Nothing queued — the media came down fine, but it could not be watermarked.\n\n` +
          `<code>${escapeHtml(stamped.error)}</code>`,
        { parse_mode: 'HTML', ...replyTo(message) },
      );
      return;
    }
    await ctx.reply(
      `⚠️ Posting this without a watermark — it could not be stamped.\n\n` +
        `<code>${escapeHtml(stamped.error)}</code>`,
      { parse_mode: 'HTML', ...replyTo(message) },
    );
  }

  const download = stamped?.ok ? { ...result.download, file: stamped.file } : result.download;

  try {
    const sent = await sendDownload(ctx, message, url, note, download);
    // Already the stamped copy, so it goes to the queue as it is.
    await queueMessages(ctx, [sent]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await giveUp(
      `Downloaded ${formatBytes(result.download.bytes)}, but sending it here failed: ${reason}`,
    );
  } finally {
    await result.cleanup().catch(() => undefined);
    if (stamped?.ok) await stamped.cleanup().catch(() => undefined);
  }
}

export function registerHandlers(bot: Bot): void {
  // --- Channel discovery & delay clock -------------------------------------
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.myChatMember.chat;
    if (chat.type === 'private') return;
    const member = ctx.myChatMember.new_chat_member;
    const canPost =
      member.status === 'creator' ||
      (member.status === 'administrator' && (member.can_post_messages ?? true));

    upsertChannel({
      chatId: String(chat.id),
      title: 'title' in chat ? chat.title : null,
      username: 'username' in chat ? (chat.username ?? null) : null,
      type: chat.type,
      status: member.status,
      canPost,
    });
  });

  // Any message appearing in the channel restarts the delay countdown.
  bot.on('channel_post', async (ctx) => {
    const chat = ctx.channelPost.chat;
    upsertChannel({
      chatId: String(chat.id),
      title: chat.title,
      username: chat.username ?? null,
      type: chat.type,
    });
    touchLastPost(String(chat.id), new Date(ctx.channelPost.date * 1000));
  });

  // --- Commands ------------------------------------------------------------
  bot.command(['start', 'help'], async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx))) return;
    const help = roleOf(ctx.from?.id) === 'admin' ? ADMIN_HELP : MANAGER_HELP;
    await ctx.reply(help, { parse_mode: 'HTML' });
  });

  bot.command('delay', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx, 'admin'))) return;

    const raw = ctx.match.trim();
    if (!raw) {
      await ctx.reply(`Current delay: ${getSettings().delayMinutes} minutes. Usage: /delay 90`);
      return;
    }

    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || minutes < MIN_DELAY_MINUTES || minutes > MAX_DELAY_MINUTES) {
      await ctx.reply(`Delay must be a whole number between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES} minutes.`);
      return;
    }

    updateSettings({ delayMinutes: minutes });
    await replySchedule(ctx, `⏱ Delay set to <b>${minutes}</b> minutes.`);
  });

  bot.command('queue', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx))) return;
    const size = queueCount();
    await ctx.reply(size === 0 ? 'Queue is empty.' : `${size} post${size === 1 ? '' : 's'} in queue.`);
  });

  bot.command('till', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx))) return;
    await replySchedule(ctx);
  });

  bot.command('post', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx, 'admin'))) return;

    const result = await postNext(ctx.api, 'manual');
    if (!result.ok) {
      await ctx.reply(`⚠️ ${result.error}`);
      return;
    }
    const preview = result.preview ? `: ${escapeHtml(truncate(result.preview, 60))}` : '';
    await replySchedule(
      ctx,
      `📤 Posted ${escapeHtml(contentTypeLabel(result.contentType))}${preview}\n` +
        `<b>${queueCount()}</b> left in queue.`,
    );
  });

  bot.command('pause', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx, 'admin'))) return;

    if (getSettings().paused) {
      await ctx.reply('Posting is already paused. /resume starts it again.');
      return;
    }
    setPaused(true);
    await ctx.reply(
      `⏸ Posting paused. I keep collecting posts — <b>${queueCount()}</b> in queue.\n` +
        'Send /resume to start again.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('resume', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx, 'admin'))) return;

    if (!getSettings().paused) {
      await ctx.reply('Posting is already running.');
      return;
    }
    setPaused(false);
    await replySchedule(ctx, '▶️ Posting resumed.');
  });

  bot.command('clear', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx, 'admin'))) return;
    const removed = clearQueue();
    await syncQueueHead(ctx.api);
    await ctx.reply(removed === 0 ? 'Queue was already empty.' : `🗑 Cleared ${removed} queued post${removed === 1 ? '' : 's'}.`);
  });

  bot.command('summary', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx))) return;

    const { timezone } = getSettings();
    const schedule = getSchedule();
    const runwayMs = schedule.queueCount * schedule.delayMinutes * 60_000;

    const lines = [
      '<b>Summary</b>',
      `Queue: <b>${schedule.queueCount}</b> post${schedule.queueCount === 1 ? '' : 's'}`,
      `Delay: <b>${schedule.delayMinutes}</b> min`,
    ];

    if (schedule.window) {
      lines.push(`Window: <b>${schedule.window.start}–${schedule.window.end}</b>`);
    }

    if (schedule.nextPostAt && schedule.queueCount > 0) {
      lines.push(
        `Next post: <b>${escapeHtml(formatInTimezone(schedule.nextPostAt, timezone))}</b>` +
          ` (in ${formatDuration(schedule.msRemaining)})`,
      );
      lines.push(`Runway: <b>${formatDuration(runwayMs)}</b> of content`);
      if (schedule.queueEmptiesAt) {
        lines.push(
          `Queue empties: <b>${escapeHtml(formatInTimezone(schedule.queueEmptiesAt, timezone))}</b>`,
        );
      }
    } else if (schedule.blocked) {
      lines.push(`⚠️ ${escapeHtml(schedule.blocked)}`);
    }

    if (schedule.targetChannelTitle) {
      lines.push(`Channel: ${escapeHtml(schedule.targetChannelTitle)}`);
    }
    lines.push(`Time zone: ${escapeHtml(timezone)}`);

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // --- Anything else the admin sends becomes a post ------------------------
  bot.on('message', async (ctx) => {
    if (!isPrivate(ctx)) return;
    if (!(await guard(ctx))) return;

    const message = ctx.message;

    // Unknown slash command — don't silently queue a typo.
    const isCommand = message.entities?.some((e) => e.type === 'bot_command' && e.offset === 0);
    if (isCommand) {
      await ctx.reply('Unknown command. Send /help for the list.');
      return;
    }

    if (message.media_group_id) {
      bufferAlbumMessage(message.media_group_id, message, (messages) => {
        void queueWithWatermark(ctx, messages).catch((error) =>
          console.error('[bot] album queue failed', error),
        );
      });
      return;
    }

    // A link stands for the media behind it, not for itself.
    const request = extractDownloadRequest(message);
    if (request) {
      await handleLink(ctx, message, request.url, request.note);
      return;
    }

    await queueWithWatermark(ctx, [message]);
  });

  bot.catch((error) => {
    console.error('[bot] update failed:', error.message);
  });
}

/**
 * Only known users get answered — strangers are ignored silently. Managers may
 * queue posts and read the schedule; `need: 'admin'` marks the commands that
 * change configuration or publish. When nobody is configured yet, tell whoever
 * wrote their own id so they can paste it into the dashboard.
 */
async function guard(ctx: Context, need: 'any' | 'admin' = 'any'): Promise<boolean> {
  if (hasNoUsers()) {
    await ctx.reply(
      `This bot has no admin configured yet.\nYour Telegram user ID is <code>${ctx.from?.id}</code> — set it in the dashboard.`,
      { parse_mode: 'HTML' },
    );
    return false;
  }

  const from = ctx.from;
  const user = from ? getUser(String(from.id)) : undefined;
  if (!user) return false;

  // Free name refresh: the dashboard shows this without calling getChat.
  const label = from?.username ? `@${from.username}` : (from?.first_name ?? null);
  if (label && label !== user.label) setLabel(user.telegramId, label);

  // Their chat exists now, so a menu that could not be set earlier can be.
  void ensureCommandMenu(ctx.api, user.telegramId, user.role);

  if (need === 'admin' && user.role !== 'admin') {
    await ctx.reply('That command is admin-only. You can still send me posts for the queue.');
    return false;
  }
  return true;
}

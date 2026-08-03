import type { Api } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';
import type { Channel, QueueItem } from '../db/schema.js';
import { getChannel, postableChannels, touchLastPost } from './channels.js';
import { peekNext, queueCount, recordPost, removeQueueItem } from './queue.js';
import { getSettings } from './settings.js';

export type TargetResolution =
  | { ok: true; channel: Channel }
  | { ok: false; reason: 'no-channels' | 'ambiguous' | 'not-admin' };

/**
 * Where do we publish? An explicit setting wins; otherwise, if the bot is
 * admin in exactly one channel, that one is used implicitly.
 */
export function resolveTarget(): TargetResolution {
  const { targetChannelId } = getSettings();
  const postable = postableChannels();

  if (targetChannelId) {
    const channel = getChannel(targetChannelId);
    if (!channel) return { ok: false, reason: 'no-channels' };
    if (channel.status !== 'administrator' && channel.status !== 'creator') {
      return { ok: false, reason: 'not-admin' };
    }
    return { ok: true, channel };
  }

  if (postable.length === 0) return { ok: false, reason: 'no-channels' };
  if (postable.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, channel: postable[0]! };
}

type TargetError = Extract<TargetResolution, { ok: false }>['reason'];

export function targetErrorMessage(reason: TargetError): string {
  switch (reason) {
    case 'no-channels':
      return 'No target channel. Add the bot to a channel as an administrator with permission to post.';
    case 'ambiguous':
      return 'The bot is an admin in several channels. Pick the target channel in the dashboard.';
    case 'not-admin':
      return 'The bot is no longer an administrator in the selected channel.';
    default:
      return 'Target channel is not available.';
  }
}

export type Schedule = {
  targetChannelId: string | null;
  targetChannelTitle: string | null;
  lastPostAt: Date | null;
  nextPostAt: Date | null;
  msRemaining: number;
  dueNow: boolean;
  delayMinutes: number;
  queueCount: number;
  paused: boolean;
  blocked: string | null;
};

const PAUSED_MESSAGE = 'Posting is paused.';

export function getSchedule(now = new Date()): Schedule {
  const { delayMinutes, paused } = getSettings();
  const target = resolveTarget();
  const pending = queueCount();

  if (!target.ok) {
    return {
      targetChannelId: null,
      targetChannelTitle: null,
      lastPostAt: null,
      nextPostAt: null,
      msRemaining: 0,
      dueNow: false,
      delayMinutes,
      queueCount: pending,
      paused,
      blocked: targetErrorMessage(target.reason),
    };
  }

  const { channel } = target;

  // Paused: the target is fine, there just is no next post until we resume.
  if (paused) {
    return {
      targetChannelId: channel.chatId,
      targetChannelTitle: channel.title,
      lastPostAt: channel.lastPostAt ?? null,
      nextPostAt: null,
      msRemaining: 0,
      dueNow: false,
      delayMinutes,
      queueCount: pending,
      paused,
      blocked: PAUSED_MESSAGE,
    };
  }

  const lastPostAt = channel.lastPostAt ?? null;
  // Nothing has ever been posted in the channel: publish on the next tick.
  const nextPostAt = lastPostAt ? new Date(lastPostAt.getTime() + delayMinutes * 60_000) : now;
  const msRemaining = Math.max(0, nextPostAt.getTime() - now.getTime());

  return {
    targetChannelId: channel.chatId,
    targetChannelTitle: channel.title,
    lastPostAt,
    nextPostAt,
    msRemaining,
    dueNow: msRemaining <= 0,
    delayMinutes,
    queueCount: pending,
    paused,
    blocked: pending === 0 ? 'Queue is empty.' : null,
  };
}

export type PostResult =
  | { ok: true; channelId: string; messageIds: number[]; preview: string; contentType: string }
  | { ok: false; error: string };

let posting = false;

/**
 * The last failure we replied about. A failing item stays at the head of the
 * queue, so the scheduler retries it every minute — without this the sender
 * would get the same complaint once a minute forever.
 */
let reportedFailure: { itemId: number; error: string } | null = null;

type Emoji = ReactionTypeEmoji['emoji'];

/** Published. */
const POSTED_EMOJI: Emoji = '👍';
/**
 * First in the queue — the next thing that goes out. Telegram allows bots only
 * a fixed set of reaction emoji, and "❗" is not one of them; ⚡ is the closest
 * available "attention, this one is next" marker.
 */
const NEXT_UP_EMOJI: Emoji = '⚡';

/** The queue head we have already marked, so we can unmark it when it changes. */
let markedHead: { itemId: number; sourceChatId: string; messageId: number } | null = null;

/** Sets (or with `null`, clears) our reaction. Never throws: it's a nicety. */
async function react(
  api: Api,
  chatId: string,
  messageId: number,
  emoji: Emoji | null,
): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, emoji ? [{ type: 'emoji', emoji }] : []);
  } catch (error) {
    console.warn('[poster] could not react to the source message:', describeError(error));
  }
}

/** Marks the original message as published. */
async function markPosted(api: Api, item: QueueItem): Promise<void> {
  await react(api, item.sourceChatId, item.messageIds[0]!, POSTED_EMOJI);
}

/**
 * Keeps the ⚡ mark on the message at the head of the queue. Call after
 * anything that changes the queue; it's a no-op when the head is unchanged.
 */
export async function syncQueueHead(api: Api): Promise<void> {
  const head = peekNext();
  if ((head?.id ?? null) === (markedHead?.itemId ?? null)) return;

  const previous = markedHead;
  markedHead = head
    ? { itemId: head.id, sourceChatId: head.sourceChatId, messageId: head.messageIds[0]! }
    : null;

  // The old head left the queue without being posted (deleted, or the queue was
  // cleared) — a posted item is forgotten first, so its 👍 survives.
  if (previous) await react(api, previous.sourceChatId, previous.messageId, null);
  if (markedHead) await react(api, markedHead.sourceChatId, markedHead.messageId, NEXT_UP_EMOJI);
}

/** Replies to the original message with what went wrong. Never throws. */
async function reportFailure(api: Api, item: QueueItem, error: string): Promise<void> {
  if (reportedFailure?.itemId === item.id && reportedFailure.error === error) return;
  reportedFailure = { itemId: item.id, error };

  try {
    await api.sendMessage(
      item.sourceChatId,
      `⚠️ Could not post this to the channel.\n\n${error}\n\nIt stays first in the queue and will be retried.`,
      {
        reply_parameters: { message_id: item.messageIds[0]!, allow_sending_without_reply: true },
      },
    );
  } catch (sendError) {
    console.warn('[poster] could not report the failure to the sender:', describeError(sendError));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Publishes the head of the queue. Serialized so ticks and /post cannot race. */
export async function postNext(api: Api, mode: 'auto' | 'manual'): Promise<PostResult> {
  if (posting) return { ok: false, error: 'A post is already in progress.' };
  posting = true;
  // Kept outside the try so the catch below knows which post to reply to.
  let item: QueueItem | undefined;
  try {
    item = peekNext();
    if (!item) return { ok: false, error: 'Queue is empty.' };

    const target = resolveTarget();
    if (!target.ok) {
      const error = targetErrorMessage(target.reason);
      await reportFailure(api, item, error);
      return { ok: false, error };
    }

    const channelId = target.channel.chatId;
    let sentIds: number[];

    if (item.messageIds.length > 1) {
      const sent = await api.copyMessages(channelId, item.sourceChatId, item.messageIds);
      sentIds = sent.map((m) => m.message_id);
    } else {
      const sent = await api.copyMessage(channelId, item.sourceChatId, item.messageIds[0]!);
      sentIds = [sent.message_id];
    }

    const postedAt = new Date();
    removeQueueItem(item.id);
    recordPost({
      channelId,
      messageIds: sentIds,
      contentType: item.contentType,
      preview: item.preview,
      mode,
      postedAt,
    });
    // Restart the countdown immediately; the channel_post update may lag.
    touchLastPost(channelId, postedAt);
    if (reportedFailure?.itemId === item.id) reportedFailure = null;
    // Forget it before reacting, so syncQueueHead doesn't wipe the 👍 we set.
    if (markedHead?.itemId === item.id) markedHead = null;
    await markPosted(api, item);
    await syncQueueHead(api);

    return {
      ok: true,
      channelId,
      messageIds: sentIds,
      preview: item.preview,
      contentType: item.contentType,
    };
  } catch (error) {
    const message = describeError(error);
    if (item) await reportFailure(api, item, message);
    return { ok: false, error: message };
  } finally {
    posting = false;
  }
}

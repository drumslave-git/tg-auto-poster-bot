import type { Api } from 'grammy';
import type { Channel } from '../db/schema.js';
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
  blocked: string | null;
};

export function getSchedule(now = new Date()): Schedule {
  const { delayMinutes } = getSettings();
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
      blocked: targetErrorMessage(target.reason),
    };
  }

  const { channel } = target;
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
    blocked: pending === 0 ? 'Queue is empty.' : null,
  };
}

export type PostResult =
  | { ok: true; channelId: string; messageIds: number[]; preview: string; contentType: string }
  | { ok: false; error: string };

let posting = false;

/** Publishes the head of the queue. Serialized so ticks and /post cannot race. */
export async function postNext(api: Api, mode: 'auto' | 'manual'): Promise<PostResult> {
  if (posting) return { ok: false, error: 'A post is already in progress.' };
  posting = true;
  try {
    const target = resolveTarget();
    if (!target.ok) return { ok: false, error: targetErrorMessage(target.reason) };

    const item = peekNext();
    if (!item) return { ok: false, error: 'Queue is empty.' };

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

    return {
      ok: true,
      channelId,
      messageIds: sentIds,
      preview: item.preview,
      contentType: item.contentType,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    posting = false;
  }
}

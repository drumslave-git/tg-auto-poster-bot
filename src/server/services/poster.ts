import type { Api } from 'grammy';
import type { MessageEntity, ReactionTypeEmoji } from 'grammy/types';
import type { Channel, QueuedPost } from '../db/schema.js';
import { clip } from '../util/format.js';
import {
  formatClock,
  minutesOfDay,
  nextWindowOpen,
  withinWindow,
} from '../util/time.js';
import { getChannel, postableChannels, touchLastPost } from './channels.js';
import { peekNext, queueCount, recordPost } from './queue.js';
import { getSettings, postFooter, postingWindow, type PostingWindow } from './settings.js';

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
  /** When the last post now in the queue goes out; null while the queue is empty. */
  queueEmptiesAt: Date | null;
  msRemaining: number;
  dueNow: boolean;
  delayMinutes: number;
  queueCount: number;
  paused: boolean;
  /** The window posting is confined to, as clock times, or null for any time. */
  window: { start: string; end: string } | null;
  blocked: string | null;
};

const PAUSED_MESSAGE = 'Posting is paused.';

/**
 * How far ahead the queue is projected. Walking the window post by post is the
 * only way to get an honest emptying date once posting is confined to a few
 * hours a day, and a queue longer than this has a date too far off to be worth
 * the arithmetic on every dashboard push.
 */
const MAX_PROJECTED_POSTS = 500;

/**
 * The first moment at or after `due` that the window allows, never earlier than
 * `now` — a window the bot slept through is a window it missed, and the backlog
 * waits for the next one rather than spilling out at midnight.
 */
function nextSlot(due: Date, now: Date, window: PostingWindow, timezone: string): Date {
  const earliest = due.getTime() > now.getTime() ? due : now;
  return withinWindow(minutesOfDay(earliest, timezone), window.start, window.end)
    ? earliest
    : nextWindowOpen(earliest, timezone, window.start);
}

/** Walks the queue forward from its first post to find when the last one lands. */
function projectEmptyAt(
  first: Date,
  pending: number,
  delayMinutes: number,
  window: PostingWindow | null,
  timezone: string,
): Date | null {
  if (pending <= 0) return null;
  if (!window) return new Date(first.getTime() + (pending - 1) * delayMinutes * 60_000);

  let at = first;
  for (let posted = 1; posted < Math.min(pending, MAX_PROJECTED_POSTS); posted += 1) {
    const due = new Date(at.getTime() + delayMinutes * 60_000);
    at = withinWindow(minutesOfDay(due, timezone), window.start, window.end)
      ? due
      : nextWindowOpen(due, timezone, window.start);
  }
  return at;
}

export function getSchedule(now = new Date()): Schedule {
  const settings = getSettings();
  const { delayMinutes, paused, timezone } = settings;
  const window = postingWindow(settings);
  const windowLabel = window
    ? { start: formatClock(window.start), end: formatClock(window.end) }
    : null;
  const target = resolveTarget();
  const pending = queueCount();

  if (!target.ok) {
    return {
      targetChannelId: null,
      targetChannelTitle: null,
      lastPostAt: null,
      nextPostAt: null,
      queueEmptiesAt: null,
      msRemaining: 0,
      dueNow: false,
      delayMinutes,
      queueCount: pending,
      paused,
      window: windowLabel,
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
      queueEmptiesAt: null,
      msRemaining: 0,
      dueNow: false,
      delayMinutes,
      queueCount: pending,
      paused,
      window: windowLabel,
      blocked: PAUSED_MESSAGE,
    };
  }

  const lastPostAt = channel.lastPostAt ?? null;
  // Nothing has ever been posted in the channel: publish on the next tick.
  const due = lastPostAt ? new Date(lastPostAt.getTime() + delayMinutes * 60_000) : now;
  const nextPostAt = window ? nextSlot(due, now, window, timezone) : due;
  const msRemaining = Math.max(0, nextPostAt.getTime() - now.getTime());

  const outsideWindow =
    window !== null && !withinWindow(minutesOfDay(now, timezone), window.start, window.end);

  return {
    targetChannelId: channel.chatId,
    targetChannelTitle: channel.title,
    lastPostAt,
    nextPostAt,
    queueEmptiesAt: projectEmptyAt(nextPostAt, pending, delayMinutes, window, timezone),
    msRemaining,
    dueNow: msRemaining <= 0,
    delayMinutes,
    queueCount: pending,
    paused,
    window: windowLabel,
    blocked:
      pending === 0
        ? 'Queue is empty.'
        : outsideWindow && windowLabel
          ? `Outside the posting window (${windowLabel.start}–${windowLabel.end}).`
          : null,
  };
}

export type PostResult =
  | {
      ok: true;
      channelId: string;
      channelMessageIds: number[];
      preview: string;
      contentType: string;
    }
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
async function markPosted(api: Api, item: QueuedPost): Promise<void> {
  await react(api, item.sourceChatId, item.sourceMessageIds[0]!, POSTED_EMOJI);
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
    ? { itemId: head.id, sourceChatId: head.sourceChatId, messageId: head.sourceMessageIds[0]! }
    : null;

  // The old head left the queue without being posted (deleted, or the queue was
  // cleared) — a posted item is forgotten first, so its 👍 survives.
  if (previous) await react(api, previous.sourceChatId, previous.messageId, null);
  if (markedHead) await react(api, markedHead.sourceChatId, markedHead.messageId, NEXT_UP_EMOJI);
}

/** Replies to the original message with what went wrong. Never throws. */
async function reportFailure(api: Api, item: QueuedPost, error: string): Promise<void> {
  if (reportedFailure?.itemId === item.id && reportedFailure.error === error) return;
  reportedFailure = { itemId: item.id, error };

  try {
    await api.sendMessage(
      item.sourceChatId,
      `⚠️ Could not post this to the channel.\n\n${error}\n\nIt stays first in the queue and will be retried.`,
      {
        reply_parameters: {
          message_id: item.sourceMessageIds[0]!,
          allow_sending_without_reply: true,
        },
      },
    );
  } catch (sendError) {
    console.warn('[poster] could not report the failure to the sender:', describeError(sendError));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Telegram's ceilings on a single message. */
const MAX_CAPTION_LENGTH = 1024;
const MAX_TEXT_LENGTH = 4096;

/** Content types whose caption `copyMessage` is able to replace. */
const CAPTIONABLE = new Set(['photo', 'video', 'animation', 'audio', 'document', 'voice']);

type Extended = { field: 'caption' | 'text'; text: string; entities: MessageEntity[] };

/** Drops the entities past the cut and shortens the one straddling it. */
function clipEntities(entities: MessageEntity[], length: number): MessageEntity[] {
  return entities
    .filter((entity) => entity.offset < length)
    .map((entity) =>
      entity.offset + entity.length <= length
        ? entity
        : { ...entity, length: length - entity.offset },
    );
}

/**
 * A bot may only send a custom emoji from a set it owns, so re-stating one the
 * sender used would be rejected — and a post that cannot be sent sits at the
 * head of the queue failing every minute. Dropping the entity leaves the
 * placeholder character in the text, which is what a client without the set
 * shows anyway. Only the footer paths restate entities; a plain copy keeps them.
 */
function sendableEntities(entities: MessageEntity[]): MessageEntity[] {
  return entities.filter((entity) => entity.type !== 'custom_emoji');
}

/**
 * The post's own words with the footer glued on, or null when this post has
 * nowhere to put it and the footer has to follow as a message of its own.
 */
function withFooter(item: QueuedPost, footer: string): Extended | null {
  // A row queued before the bot kept the text has nothing to append to: giving
  // copyMessage a caption would replace the original with the footer alone.
  if (item.sourceText === null) return null;
  // copyMessages takes no caption, and an album's caption lives on whichever
  // item carries it — there is no way in.
  if (item.kind === 'album') return null;

  const field =
    item.contentType === 'text' ? 'text' : CAPTIONABLE.has(item.contentType) ? 'caption' : null;
  // A sticker, a poll, a location: nothing to write on.
  if (!field) return null;

  const limit = field === 'text' ? MAX_TEXT_LENGTH : MAX_CAPTION_LENGTH;
  const separator = item.sourceText ? '\n\n' : '';
  // The footer is the part that has to survive, so the post's words give way.
  const room = limit - footer.length - separator.length;

  let text = item.sourceText;
  let entities = sendableEntities(item.sourceEntities ?? []);
  if (text.length > room) {
    text = `${clip(text, Math.max(0, room - 1))}…`;
    entities = clipEntities(entities, text.length);
  }

  return { field, text: text + separator + footer, entities };
}

/**
 * The footer as a message of its own, for posts it cannot be written into.
 * Never throws: the post is already in the channel by the time this runs, and
 * failing here would send the whole thing again on the next tick.
 */
async function sendFooterMessage(
  api: Api,
  channelId: string,
  footer: string,
): Promise<number | null> {
  try {
    const sent = await api.sendMessage(channelId, footer);
    return sent.message_id;
  } catch (error) {
    console.warn('[poster] could not append the footer:', describeError(error));
    return null;
  }
}

/** Publishes the head of the queue. Serialized so ticks and /post cannot race. */
export async function postNext(api: Api, mode: 'auto' | 'manual'): Promise<PostResult> {
  if (posting) return { ok: false, error: 'A post is already in progress.' };
  posting = true;
  // Kept outside the try so the catch below knows which post to reply to.
  let item: QueuedPost | undefined;
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
    const footer = postFooter(getSettings());
    const extended = footer ? withFooter(item, footer) : null;
    let sentIds: number[];

    if (item.sourceMessageIds.length > 1) {
      const sent = await api.copyMessages(channelId, item.sourceChatId, item.sourceMessageIds);
      sentIds = sent.map((m) => m.message_id);
    } else if (extended?.field === 'caption') {
      const sent = await api.copyMessage(channelId, item.sourceChatId, item.sourceMessageIds[0]!, {
        caption: extended.text,
        caption_entities: extended.entities,
      });
      sentIds = [sent.message_id];
    } else if (extended?.field === 'text') {
      // Words are all a text post is, and copyMessage cannot change them, so
      // this one is re-sent instead of copied. The result is identical.
      const sent = await api.sendMessage(channelId, extended.text, { entities: extended.entities });
      sentIds = [sent.message_id];
    } else {
      const sent = await api.copyMessage(channelId, item.sourceChatId, item.sourceMessageIds[0]!);
      sentIds = [sent.message_id];
    }

    // An album, a sticker, a poll: nothing the footer fits into, so it follows.
    if (footer && !extended) {
      const trailing = await sendFooterMessage(api, channelId, footer);
      if (trailing !== null) sentIds.push(trailing);
    }

    // Stamping the row publishes it: it leaves the queue and enters the history.
    const postedAt = new Date();
    recordPost(item.id, { channelId, channelMessageIds: sentIds, mode, postedAt });
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
      channelMessageIds: sentIds,
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

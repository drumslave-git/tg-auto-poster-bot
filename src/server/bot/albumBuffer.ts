import type { Message } from 'grammy/types';

/**
 * Telegram delivers an album as N separate updates sharing a media_group_id.
 * We collect them for a short window so the whole album becomes one queue item.
 */
const FLUSH_DELAY_MS = 1500;

type Pending = { messages: Message[]; timer: NodeJS.Timeout };

const buffers = new Map<string, Pending>();

export function bufferAlbumMessage(
  groupId: string,
  message: Message,
  onFlush: (messages: Message[]) => void,
): void {
  const existing = buffers.get(groupId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(message);
    existing.timer = setTimeout(() => flush(groupId, onFlush), FLUSH_DELAY_MS);
    return;
  }

  buffers.set(groupId, {
    messages: [message],
    timer: setTimeout(() => flush(groupId, onFlush), FLUSH_DELAY_MS),
  });
}

function flush(groupId: string, onFlush: (messages: Message[]) => void): void {
  const pending = buffers.get(groupId);
  buffers.delete(groupId);
  if (!pending) return;
  pending.messages.sort((a, b) => a.message_id - b.message_id);
  onFlush(pending.messages);
}

export function clearAlbumBuffers(): void {
  for (const pending of buffers.values()) clearTimeout(pending.timer);
  buffers.clear();
}

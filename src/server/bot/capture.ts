import type { Message } from 'grammy/types';
import { truncate } from '../util/format.js';

/** Best-effort label of what a message carries, used for the queue preview. */
export function detectContentType(message: Message): string {
  if (message.photo) return 'photo';
  if (message.video) return 'video';
  if (message.animation) return 'animation';
  if (message.audio) return 'audio';
  if (message.voice) return 'voice';
  if (message.video_note) return 'video_note';
  if (message.document) return 'document';
  if (message.sticker) return 'sticker';
  if (message.poll) return 'poll';
  if (message.location) return 'location';
  if (message.venue) return 'location';
  if (message.contact) return 'contact';
  if (message.text) return 'text';
  return 'other';
}

export function describe(messages: Message[]): { contentType: string; preview: string } {
  const first = messages[0]!;
  const contentType = messages.length > 1 ? 'album' : detectContentType(first);
  const text = messages.map((m) => m.text ?? m.caption ?? '').find((t) => t.length > 0) ?? '';

  if (text) return { contentType, preview: truncate(text) };

  const inner =
    messages.length > 1
      ? `${messages.length} items`
      : (first.poll?.question ?? first.document?.file_name ?? first.sticker?.emoji ?? '');

  return { contentType, preview: inner ? truncate(inner) : '' };
}

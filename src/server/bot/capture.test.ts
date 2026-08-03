import type { Message } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { describe as describeMessages, detectContentType } from './capture.js';

/** Only the fields the code under test looks at; the rest never gets read. */
function message(partial: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, ...partial } as Message;
}

describe('detectContentType', () => {
  it('names each media kind', () => {
    expect(detectContentType(message({ photo: [] as never }))).toBe('photo');
    expect(detectContentType(message({ video: {} as never }))).toBe('video');
    expect(detectContentType(message({ animation: {} as never }))).toBe('animation');
    expect(detectContentType(message({ audio: {} as never }))).toBe('audio');
    expect(detectContentType(message({ voice: {} as never }))).toBe('voice');
    expect(detectContentType(message({ video_note: {} as never }))).toBe('video_note');
    expect(detectContentType(message({ document: {} as never }))).toBe('document');
    expect(detectContentType(message({ sticker: {} as never }))).toBe('sticker');
    expect(detectContentType(message({ poll: {} as never }))).toBe('poll');
    expect(detectContentType(message({ location: {} as never }))).toBe('location');
    expect(detectContentType(message({ contact: {} as never }))).toBe('contact');
    expect(detectContentType(message({ text: 'hi' }))).toBe('text');
  });

  it('treats a venue as a location', () => {
    expect(detectContentType(message({ venue: {} as never }))).toBe('location');
  });

  it('prefers the media over the caption text', () => {
    expect(detectContentType(message({ photo: [] as never, caption: 'hi' }))).toBe('photo');
  });

  it('falls back to "other" for anything unrecognised', () => {
    expect(detectContentType(message({}))).toBe('other');
  });
});

describe('describe', () => {
  it('previews a single message with its text', () => {
    expect(describeMessages([message({ text: '  hello   world ' })])).toEqual({
      contentType: 'text',
      preview: 'hello world',
    });
  });

  it('uses the caption when there is no text', () => {
    expect(describeMessages([message({ photo: [] as never, caption: 'a cat' })])).toEqual({
      contentType: 'photo',
      preview: 'a cat',
    });
  });

  it('calls several messages an album and takes the first caption it finds', () => {
    const messages = [
      message({ message_id: 1, photo: [] as never }),
      message({ message_id: 2, photo: [] as never, caption: 'second one has the text' }),
    ];
    expect(describeMessages(messages)).toEqual({
      contentType: 'album',
      preview: 'second one has the text',
    });
  });

  it('falls back to the item count for a captionless album', () => {
    const messages = [
      message({ message_id: 1, photo: [] as never }),
      message({ message_id: 2, photo: [] as never }),
      message({ message_id: 3, photo: [] as never }),
    ];
    expect(describeMessages(messages)).toEqual({ contentType: 'album', preview: '3 items' });
  });

  it('falls back to the poll question, file name or sticker emoji', () => {
    expect(describeMessages([message({ poll: { question: 'Which one?' } as never })]).preview).toBe(
      'Which one?',
    );
    expect(describeMessages([message({ document: { file_name: 'report.pdf' } as never })]).preview).toBe(
      'report.pdf',
    );
    expect(describeMessages([message({ sticker: { emoji: '🎉' } as never })]).preview).toBe('🎉');
  });

  it('leaves the preview empty when there is nothing to show', () => {
    expect(describeMessages([message({ video: {} as never })])).toEqual({
      contentType: 'video',
      preview: '',
    });
  });

  it('truncates a long preview', () => {
    expect(describeMessages([message({ text: 'x'.repeat(300) })]).preview).toHaveLength(140);
  });
});

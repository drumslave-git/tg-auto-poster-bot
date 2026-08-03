import { describe, expect, it } from 'vitest';
import type { Message, PhotoSize } from 'grammy/types';
import { safeName, stampableMedia } from './stamp.js';

function message(patch: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, ...patch } as Message;
}

function size(fileId: string, bytes?: number): PhotoSize {
  return { file_id: fileId, file_unique_id: fileId, width: 10, height: 10, file_size: bytes };
}

describe('stampableMedia', () => {
  it('takes the largest size of a photo, which is the one that gets posted', () => {
    const found = stampableMedia(
      message({ photo: [size('small', 100), size('medium', 900), size('large', 5000)] }),
    );

    expect(found).toEqual({ fileId: 'large', kind: 'photo', bytes: 5000 });
  });

  it('finds a video', () => {
    const found = stampableMedia(
      message({
        video: {
          file_id: 'vid',
          file_unique_id: 'vid',
          width: 1920,
          height: 1080,
          duration: 12,
          file_size: 2048,
        },
      }),
    );

    expect(found).toEqual({ fileId: 'vid', kind: 'video', bytes: 2048 });
  });

  it('finds an animation', () => {
    const found = stampableMedia(
      message({
        animation: {
          file_id: 'gif',
          file_unique_id: 'gif',
          width: 320,
          height: 240,
          duration: 3,
        },
      }),
    );

    expect(found).toEqual({ fileId: 'gif', kind: 'animation', bytes: null });
  });

  it('reports no size when Telegram gave none', () => {
    expect(stampableMedia(message({ photo: [size('only')] }))?.bytes).toBeNull();
  });

  it.each([
    ['text', { text: 'hello' }],
    ['a sticker', { sticker: { file_id: 's', file_unique_id: 's', width: 1, height: 1 } }],
    ['a voice note', { voice: { file_id: 'v', file_unique_id: 'v', duration: 1 } }],
    // A picture sent as a file stays a file: re-sending it as a photo would
    // change the post more than the watermark does.
    ['a document', { document: { file_id: 'd', file_unique_id: 'd', mime_type: 'image/png' } }],
    ['a video note', { video_note: { file_id: 'n', file_unique_id: 'n', length: 1, duration: 1 } }],
  ])('leaves %s alone', (_label, patch) => {
    expect(stampableMedia(message(patch as Partial<Message>))).toBeNull();
  });
});

describe('safeName', () => {
  it('keeps the extension, which is how ffmpeg knows what it is opening', () => {
    expect(safeName('photos/file_12.jpg')).toBe('file_12.jpg');
  });

  it('refuses to be talked out of the directory it was given', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('videos/../../../root/.ssh/id_rsa')).toBe('id_rsa');
  });

  it('strips anything that is not a plain filename character', () => {
    expect(safeName('a b;rm -rf/c$(x).mp4')).toBe('cx.mp4');
  });

  it('always answers with something usable', () => {
    expect(safeName('///')).toBe('media');
  });
});

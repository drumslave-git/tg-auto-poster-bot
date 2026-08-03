import type { Message, MessageEntity } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  FIELD_SEPARATOR,
  MAX_DOWNLOAD_BYTES,
  buildYtDlpArgs,
  extractDownloadUrl,
  mediaKindFor,
  mentionsSizeLimit,
  parseMetadata,
} from './download.js';

/** Only the fields the code under test looks at; the rest never gets read. */
function message(partial: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, ...partial } as Message;
}

function urlEntity(offset: number, length: number): MessageEntity {
  return { type: 'url', offset, length };
}

describe('extractDownloadUrl', () => {
  it('takes the link Telegram marked up', () => {
    const text = 'look at https://example.com/clip please';
    expect(extractDownloadUrl(message({ text, entities: [urlEntity(8, 24)] }))).toBe(
      'https://example.com/clip',
    );
  });

  it('follows a hidden link to its target', () => {
    expect(
      extractDownloadUrl(
        message({
          text: 'this one',
          entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://example.com/v/1' }],
        }),
      ),
    ).toBe('https://example.com/v/1');
  });

  it('takes the first of several links', () => {
    const text = 'https://a.example/1 and https://b.example/2';
    expect(
      extractDownloadUrl(message({ text, entities: [urlEntity(24, 19), urlEntity(0, 19)] })),
    ).toBe('https://a.example/1');
  });

  it('finds a link even without entities', () => {
    expect(extractDownloadUrl(message({ text: 'see http://example.com/a.mp4' }))).toBe(
      'http://example.com/a.mp4',
    );
  });

  it('drops punctuation the sentence glued to the link', () => {
    expect(extractDownloadUrl(message({ text: 'watch https://example.com/clip.' }))).toBe(
      'https://example.com/clip',
    );
    expect(extractDownloadUrl(message({ text: '(https://example.com/clip)' }))).toBe(
      'https://example.com/clip',
    );
  });

  it('ignores text with no link in it', () => {
    expect(extractDownloadUrl(message({ text: 'just a thought' }))).toBeNull();
    // No entity and no scheme — nothing here says "link".
    expect(extractDownloadUrl(message({ text: 'example.com/clip' }))).toBeNull();
  });

  it('accepts only http and https', () => {
    const hidden = (url: string) =>
      extractDownloadUrl(
        message({ text: 'tap', entities: [{ type: 'text_link', offset: 0, length: 3, url }] }),
      );

    expect(hidden('https://example.com/clip')).toBe('https://example.com/clip');
    expect(hidden('http://example.com/clip')).toBe('http://example.com/clip');
    expect(hidden('file:///etc/passwd')).toBeNull();
    expect(hidden('tg://resolve?domain=x')).toBeNull();
    expect(hidden('javascript:alert(1)')).toBeNull();
    expect(hidden('ftp://example.com/clip')).toBeNull();
    expect(hidden('not a url at all')).toBeNull();
  });

  it('gives a bare domain the scheme Telegram left off', () => {
    // Telegram marks `example.com/clip` as a url entity, without a scheme.
    expect(
      extractDownloadUrl(message({ text: 'example.com/clip', entities: [urlEntity(0, 16)] })),
    ).toBe('https://example.com/clip');
  });

  it('rejects a scheme with nothing behind it', () => {
    expect(extractDownloadUrl(message({ text: 'https://' }))).toBeNull();
  });

  it('leaves media alone — a caption link is not a download request', () => {
    expect(
      extractDownloadUrl(
        message({ photo: [] as never, caption: 'from https://example.com/clip' }),
      ),
    ).toBeNull();
    expect(extractDownloadUrl(message({ video: {} as never }))).toBeNull();
  });
});

describe('mediaKindFor', () => {
  it('routes each extension to the way Telegram plays it', () => {
    expect(mediaKindFor('/tmp/x/media.mp4')).toBe('video');
    expect(mediaKindFor('/tmp/x/media.webm')).toBe('video');
    expect(mediaKindFor('/tmp/x/media.gif')).toBe('animation');
    expect(mediaKindFor('/tmp/x/media.m4a')).toBe('audio');
    expect(mediaKindFor('/tmp/x/media.jpg')).toBe('photo');
  });

  it('ignores the case of the extension', () => {
    expect(mediaKindFor('/tmp/x/MEDIA.MP4')).toBe('video');
  });

  it('falls back to a plain document', () => {
    expect(mediaKindFor('/tmp/x/media.pdf')).toBe('document');
    expect(mediaKindFor('/tmp/x/media')).toBe('document');
  });
});

describe('parseMetadata', () => {
  const line = (...fields: (string | number)[]) => fields.join(FIELD_SEPARATOR);

  it('reads the printed fields', () => {
    expect(parseMetadata(`${line('A clip', 42, 1920, 1080)}\n`)).toEqual({
      title: 'A clip',
      duration: 42,
      width: 1920,
      height: 1080,
    });
  });

  it('picks its line out of yt-dlp’s other chatter', () => {
    const stdout = ['[youtube] Extracting URL', line('A clip', 42, 1920, 1080), '[done]'].join('\n');
    expect(parseMetadata(stdout).title).toBe('A clip');
  });

  it('treats NA and blanks as unknown', () => {
    expect(parseMetadata(line('NA', 'NA', '', ''))).toEqual({
      title: null,
      duration: null,
      width: null,
      height: null,
    });
  });

  it('rounds a fractional duration and rejects nonsense', () => {
    expect(parseMetadata(line('t', '42.7', '0', 'x')).duration).toBe(43);
    expect(parseMetadata(line('t', '42.7', '0', 'x')).width).toBeNull();
    expect(parseMetadata(line('t', '42.7', '0', 'x')).height).toBeNull();
  });

  it('is all-unknown when nothing was printed', () => {
    expect(parseMetadata('')).toEqual({ title: null, duration: null, width: null, height: null });
  });
});

describe('buildYtDlpArgs', () => {
  const args = buildYtDlpArgs('https://example.com/clip', '/tmp/x/media.%(ext)s');

  it('caps the size at what a bot may upload, in plain bytes', () => {
    // A `B` suffix is a usage error, and a bare `M` would mean 10⁶.
    expect(args[args.indexOf('--max-filesize') + 1]).toBe(String(MAX_DOWNLOAD_BYTES));
  });

  it('takes separate streams before a ready-made file', () => {
    // Otherwise a DASH site hands over its muxed 360p and the rest is ignored.
    const format = args[args.indexOf('-f') + 1]!;
    expect(format.indexOf('bv*')).toBeLessThan(format.indexOf('/b['));
  });

  it('leaves the merge room for the audio stream', () => {
    const format = args[args.indexOf('-f') + 1]!;
    const videoLimit = Number(/bv\*\[filesize<=\?(\d+)\]/.exec(format)?.[1]);
    expect(videoLimit).toBeGreaterThan(0);
    expect(videoLimit).toBeLessThan(MAX_DOWNLOAD_BYTES);
  });

  it('keeps formats whose size the site does not report', () => {
    // `?` belongs after the operator — `filesize<=1000?` is a parse error.
    const format = args[args.indexOf('-f') + 1]!;
    expect(format).toContain('filesize<=?');
    expect(format).not.toMatch(/\d\?/);
  });

  it('asks for codecs that survive the merge into an mp4', () => {
    expect(args[args.indexOf('-S') + 1]).toBe('res:1080,vcodec:h264,acodec:aac');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
  });

  it('never expands a link into a whole playlist', () => {
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('--playlist-items') + 1]).toBe('1');
  });

  it('asks for the metadata only once the file is in place', () => {
    expect(args[args.indexOf('--print') + 1]).toContain('after_move:');
  });

  it('passes the url last, behind a -- guard', () => {
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://example.com/clip');
  });

  it('writes into the given template', () => {
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/x/media.%(ext)s');
  });
});

describe('mentionsSizeLimit', () => {
  it('recognises the refusal yt-dlp prints', () => {
    expect(
      mentionsSizeLimit('File is larger than max-filesize (91230000 bytes > 52428800 bytes)'),
    ).toBe(true);
  });

  it('does not fire on unrelated output', () => {
    expect(mentionsSizeLimit('ERROR: Video unavailable')).toBe(false);
  });
});

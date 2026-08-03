import type { Message, MessageEntity } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import {
  FIELD_SEPARATOR,
  MAX_DOWNLOAD_BYTES,
  buildYtDlpArgs,
  downloadCaption,
  extractDownloadRequest,
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

/** Most cases only care about the link; the note has its own block below. */
function urlIn(partial: Partial<Message>): string | null {
  return extractDownloadRequest(message(partial))?.url ?? null;
}

describe('extractDownloadRequest', () => {
  it('takes the link Telegram marked up', () => {
    const text = 'look at https://example.com/clip please';
    expect(urlIn({ text, entities: [urlEntity(8, 24)] })).toBe('https://example.com/clip');
  });

  it('follows a hidden link to its target', () => {
    expect(
      urlIn({
        text: 'this one',
        entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://example.com/v/1' }],
      }),
    ).toBe('https://example.com/v/1');
  });

  it('takes the first of several links', () => {
    const text = 'https://a.example/1 and https://b.example/2';
    expect(urlIn({ text, entities: [urlEntity(24, 19), urlEntity(0, 19)] })).toBe(
      'https://a.example/1',
    );
  });

  it('finds a link even without entities', () => {
    expect(urlIn({ text: 'see http://example.com/a.mp4' })).toBe('http://example.com/a.mp4');
  });

  it('drops punctuation the sentence glued to the link', () => {
    expect(urlIn({ text: 'watch https://example.com/clip.' })).toBe('https://example.com/clip');
    expect(urlIn({ text: '(https://example.com/clip)' })).toBe('https://example.com/clip');
  });

  it('ignores text with no link in it', () => {
    expect(urlIn({ text: 'just a thought' })).toBeNull();
    // No entity and no scheme — nothing here says "link".
    expect(urlIn({ text: 'example.com/clip' })).toBeNull();
  });

  it('accepts only http and https', () => {
    const hidden = (url: string) =>
      urlIn({ text: 'tap', entities: [{ type: 'text_link', offset: 0, length: 3, url }] });

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
    expect(urlIn({ text: 'example.com/clip', entities: [urlEntity(0, 16)] })).toBe(
      'https://example.com/clip',
    );
  });

  it('rejects a scheme with nothing behind it', () => {
    expect(urlIn({ text: 'https://' })).toBeNull();
  });

  it('leaves media alone — a caption link is not a download request', () => {
    expect(urlIn({ photo: [] as never, caption: 'from https://example.com/clip' })).toBeNull();
    expect(urlIn({ video: {} as never })).toBeNull();
  });
});

describe('extractDownloadRequest — the note', () => {
  it('keeps what the sender wrote around the link', () => {
    const text = 'look at https://example.com/clip please';

    expect(extractDownloadRequest(message({ text, entities: [urlEntity(8, 24)] }))).toEqual({
      url: 'https://example.com/clip',
      note: 'look at please',
    });
  });

  it('is empty when the link stood alone', () => {
    const text = 'https://example.com/clip';

    expect(extractDownloadRequest(message({ text, entities: [urlEntity(0, 24)] }))?.note).toBe('');
  });

  it('keeps the line breaks of a caption written under the link', () => {
    const text = 'https://example.com/clip\nFirst line\n\nSecond line';

    expect(extractDownloadRequest(message({ text, entities: [urlEntity(0, 24)] }))?.note).toBe(
      'First line\n\nSecond line',
    );
  });

  it('keeps the words a hidden link is written behind', () => {
    // The URL is not in the text at all here — every word of it is the sender's.
    expect(
      extractDownloadRequest(
        message({
          text: 'watch this one',
          entities: [{ type: 'text_link', offset: 6, length: 8, url: 'https://example.com/v/1' }],
        }),
      ),
    ).toEqual({ url: 'https://example.com/v/1', note: 'watch this one' });
  });

  it('lifts out a link found without entities', () => {
    expect(extractDownloadRequest(message({ text: 'see http://example.com/a.mp4 now' }))?.note).toBe(
      'see now',
    );
  });
});

describe('downloadCaption', () => {
  const url = 'https://www.example.com/clip';
  const titled = { title: 'A Very Good Clip' };

  it('names the media and credits the source', () => {
    expect(downloadCaption(titled, url, '', true)).toBe(
      '<b>A Very Good Clip</b>\n🔗 Source: <a href="https://www.example.com/clip">example.com</a>',
    );
  });

  it('prefers what the sender wrote to the scraped title', () => {
    expect(downloadCaption(titled, url, 'look at this', true)).toBe(
      'look at this\n🔗 Source: <a href="https://www.example.com/clip">example.com</a>',
    );
  });

  it('keeps the source line when the site offered no title', () => {
    expect(downloadCaption({ title: null }, url, '', true)).toBe(
      '🔗 Source: <a href="https://www.example.com/clip">example.com</a>',
    );
  });

  it('drops the title and the source when metadata is turned off', () => {
    expect(downloadCaption(titled, url, 'look at this', false)).toBe('look at this');
  });

  it('leaves a bare link with no caption at all when metadata is off', () => {
    expect(downloadCaption(titled, url, '', false)).toBe('');
  });

  it('escapes what the sender and the site wrote', () => {
    expect(downloadCaption({ title: '<b>hi</b>' }, url, '', true)).toContain(
      '<b>&lt;b&gt;hi&lt;/b&gt;</b>',
    );
    expect(downloadCaption(titled, url, 'a & b <c>', true)).toContain('a &amp; b &lt;c&gt;');
  });

  it('defuses a quote that would end the href early', () => {
    const caption = downloadCaption({ title: null }, 'https://example.com/a"onmouseover=x', '', true);

    expect(caption).toContain('href="https://example.com/a%22onmouseover=x"');
  });

  it('shortens a note that would crowd out the footer', () => {
    const caption = downloadCaption({ title: null }, url, 'x'.repeat(900), true);

    expect(caption.split('\n')[0]).toHaveLength(500);
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

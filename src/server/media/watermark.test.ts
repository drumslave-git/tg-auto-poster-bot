import { describe, expect, it } from 'vitest';
import type { WatermarkPlacement } from '../services/settings.js';
import {
  MAX_WATERMARK_IMAGE_BYTES,
  buildFfmpegArgs,
  buildFfprobeArgs,
  MAX_SENDABLE_BYTES,
  encodeArgs,
  overlayGeometry,
  parseProbe,
  summarizeFfmpegError,
  videoBitrateCap,
  watermarkFilter,
  watermarkImageProblem,
} from './watermark.js';

function placement(patch: Partial<WatermarkPlacement> = {}): WatermarkPlacement {
  return { x: 100, y: 100, opacity: 100, scale: 20, ...patch };
}

/** An 8-byte PNG signature followed by whatever; only the header is inspected. */
function png(bytes = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(bytes),
  ]);
}

describe('overlayGeometry', () => {
  const media = { width: 1000, height: 1000 };
  const square = { width: 100, height: 100 };

  it('sizes the watermark as a share of the media width', () => {
    expect(overlayGeometry(placement({ scale: 20 }), media, square)).toMatchObject({
      width: 200,
      height: 200,
    });
  });

  it('keeps the watermark aspect ratio rather than the media one', () => {
    const wide = { width: 200, height: 50 };
    expect(overlayGeometry(placement({ scale: 50 }), media, wide)).toMatchObject({
      width: 500,
      height: 125,
    });
  });

  it('puts 0/0 flush against the top-left corner', () => {
    expect(overlayGeometry(placement({ x: 0, y: 0 }), media, square)).toMatchObject({ x: 0, y: 0 });
  });

  it('centres the watermark at 50/50', () => {
    // 1000 wide media, 200 wide watermark: half of the 800 left over.
    expect(overlayGeometry(placement({ x: 50, y: 50 }), media, square)).toMatchObject({
      x: 400,
      y: 400,
    });
  });

  it('puts 100/100 in the bottom-right corner without cutting it off', () => {
    const geometry = overlayGeometry(placement({ x: 100, y: 100 }), media, square);

    expect(geometry).toMatchObject({ x: 800, y: 800 });
    // The far edge lands exactly on the media's edge — never past it.
    expect(geometry.x + geometry.width).toBe(media.width);
    expect(geometry.y + geometry.height).toBe(media.height);
  });

  it('never lets any setting push the watermark over an edge', () => {
    for (const x of [0, 1, 33, 50, 67, 99, 100]) {
      for (const scale of [1, 5, 40, 99, 100]) {
        const geometry = overlayGeometry(placement({ x, y: x, scale }), media, square);

        expect(geometry.x).toBeGreaterThanOrEqual(0);
        expect(geometry.y).toBeGreaterThanOrEqual(0);
        expect(geometry.x + geometry.width).toBeLessThanOrEqual(media.width);
        expect(geometry.y + geometry.height).toBeLessThanOrEqual(media.height);
      }
    }
  });

  it('shrinks a watermark too tall to fit, and keeps it on the picture', () => {
    // A 1:4 logo at half the width of a wide frame would be ten times its height.
    const geometry = overlayGeometry(
      placement({ scale: 50, x: 100, y: 100 }),
      { width: 1000, height: 200 },
      { width: 100, height: 400 },
    );

    expect(geometry).toMatchObject({ width: 50, height: 200, x: 950, y: 0 });
  });

  it('holds the watermark to a visible minimum width', () => {
    expect(overlayGeometry(placement({ scale: 1 }), { width: 100, height: 100 }, square).width).toBe(
      8,
    );
  });

  it('never makes the watermark wider than the media itself', () => {
    expect(overlayGeometry(placement({ scale: 1 }), { width: 4, height: 4 }, square).width).toBe(4);
  });

  it('covers the whole frame at 100% scale', () => {
    expect(overlayGeometry(placement({ scale: 100 }), media, square)).toMatchObject({
      width: 1000,
      height: 1000,
      x: 0,
      y: 0,
    });
  });
});

describe('watermarkFilter', () => {
  const geometry = { width: 200, height: 100, x: 800, y: 900 };

  it('scales the alpha channel rather than replacing it', () => {
    expect(watermarkFilter(placement({ opacity: 50 }), geometry)).toContain(
      'format=rgba,colorchannelmixer=aa=0.5000',
    );
  });

  it('leaves the PNG alone at full opacity', () => {
    expect(watermarkFilter(placement({ opacity: 100 }), geometry)).toContain('aa=1.0000');
  });

  it('resizes and positions from the computed geometry', () => {
    const filter = watermarkFilter(placement(), geometry);

    expect(filter).toContain('scale=200:100');
    expect(filter).toContain('overlay=800:900[v]');
  });

  it('reads the PNG from the second input and the media from the first', () => {
    expect(watermarkFilter(placement(), geometry)).toMatch(/^\[1:v\].+\[wm\];\[0:v\]\[wm\]/);
  });
});

describe('encodeArgs', () => {
  it('writes a photo back as a single high-quality frame', () => {
    expect(encodeArgs('photo')).toEqual(['-map', '[v]', '-frames:v', '1', '-q:v', '2']);
  });

  it('keeps the audio without re-encoding it, and tolerates a clip with none', () => {
    const args = encodeArgs('video').join(' ');

    expect(args).toContain('-map 0:a?');
    expect(args).toContain('-c:a copy');
  });

  it('drops the audio track from an animation, which is what makes it a GIF', () => {
    const args = encodeArgs('animation');

    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('flattens the transparency the overlay introduces', () => {
    expect(encodeArgs('video')).toContain('yuv420p');
  });

  it('caps the bitrate when it was given a budget to keep to', () => {
    const args = encodeArgs('video', 5_000_000);

    expect(args[args.indexOf('-maxrate') + 1]).toBe('5000000');
    expect(args[args.indexOf('-bufsize') + 1]).toBe('10000000');
  });

  it('leaves the rate alone when there is no duration to budget against', () => {
    expect(encodeArgs('video', null)).not.toContain('-maxrate');
  });

  it('never rate-limits a photo — it is one frame', () => {
    expect(encodeArgs('photo', 5_000_000)).not.toContain('-maxrate');
  });
});

describe('buildFfmpegArgs', () => {
  it('feeds the media first and the watermark second, as the filter expects', () => {
    const args = buildFfmpegArgs('in.mp4', 'wm.png', 'out.mp4', 'video', 'FILTER');

    expect(args.indexOf('in.mp4')).toBe(args.indexOf('-i') + 1);
    expect(args.lastIndexOf('wm.png')).toBe(args.lastIndexOf('-i') + 1);
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('FILTER');
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('never stops to ask about overwriting the output', () => {
    expect(buildFfmpegArgs('in.jpg', 'wm.png', 'out.jpg', 'photo', 'F')).toContain('-y');
  });
});

describe('buildFfprobeArgs', () => {
  it('asks only about the first video stream, and for the duration', () => {
    const args = buildFfprobeArgs('clip.mp4');

    expect(args).toContain('v:0');
    expect(args[args.indexOf('-show_entries') + 1]).toBe('stream=width,height:format=duration');
    expect(args.at(-1)).toBe('clip.mp4');
  });
});

describe('parseProbe', () => {
  it('reads the size and the duration ffprobe prints on separate lines', () => {
    expect(parseProbe('1080,1920\n71.100000\n')).toEqual({
      width: 1080,
      height: 1920,
      duration: 71.1,
    });
  });

  it('skips anything before the line that holds the numbers', () => {
    expect(parseProbe('some chatter\n\n640,480\n')).toMatchObject({ width: 640, height: 480 });
  });

  it('still measures a still image, which has no duration', () => {
    expect(parseProbe('200,100\n')).toEqual({ width: 200, height: 100, duration: null });
  });

  it('survives a container that reports no duration', () => {
    expect(parseProbe('640,480\nN/A\n')).toEqual({ width: 640, height: 480, duration: null });
  });

  it('returns null when ffprobe found no video stream', () => {
    expect(parseProbe('')).toBeNull();
    expect(parseProbe('N/A,N/A')).toBeNull();
  });

  it('rejects a stream with no real size', () => {
    expect(parseProbe('0,0')).toBeNull();
  });
});

describe('videoBitrateCap', () => {
  /** What a clip encoded right up against the cap would weigh, audio included. */
  const projectedBytes = (bps: number, duration: number, hasAudio: boolean) =>
    ((bps + (hasAudio ? 192_000 : 0)) * duration) / 8;

  it('keeps a clip encoded at the ceiling inside the upload limit', () => {
    // Everything up to the point where the quality floor takes over, which is
    // around thirteen minutes — far past anything this bot is pointed at.
    for (const duration of [5, 30, 71, 200, 700]) {
      const cap = videoBitrateCap(duration, true)!;

      expect(cap).toBeGreaterThan(300_000);
      expect(projectedBytes(cap, duration, true)).toBeLessThan(MAX_SENDABLE_BYTES);
    }
  });

  it('gives a longer clip a smaller share, since the budget is fixed', () => {
    expect(videoBitrateCap(120, true)!).toBeLessThan(videoBitrateCap(30, true)!);
  });

  it('spends the audio budget on the picture when there is no audio', () => {
    expect(videoBitrateCap(30, false)!).toBeGreaterThan(videoBitrateCap(30, true)!);
  });

  it('will not encode below a floor, however long the clip is', () => {
    expect(videoBitrateCap(3600, true)).toBe(300_000);
  });

  it('would rather overshoot the limit than encode a smear', () => {
    // Past the floor the budget can no longer be met, and this stops trying:
    // an hour of video at a watchable rate does not fit in 50 MB, so the size
    // guard refuses the result and the post goes out unstamped instead.
    const duration = 3600;
    const cap = videoBitrateCap(duration, true)!;

    expect(projectedBytes(cap, duration, true)).toBeGreaterThan(MAX_SENDABLE_BYTES);
  });

  it('has no opinion when the duration is unknown', () => {
    expect(videoBitrateCap(null, true)).toBeNull();
    expect(videoBitrateCap(0, true)).toBeNull();
  });
});

describe('watermarkImageProblem', () => {
  it('accepts a PNG', () => {
    expect(watermarkImageProblem(png())).toBeNull();
  });

  it('rejects an empty upload', () => {
    expect(watermarkImageProblem(Buffer.alloc(0))).toMatch(/empty/i);
  });

  it('rejects anything that is not a PNG', () => {
    // A JPEG's first bytes.
    expect(watermarkImageProblem(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toMatch(
      /must be a PNG/i,
    );
  });

  it('rejects a PNG larger than the ceiling', () => {
    expect(watermarkImageProblem(png(MAX_WATERMARK_IMAGE_BYTES))).toMatch(/at most/i);
  });
});

describe('summarizeFfmpegError', () => {
  it('reports the thing that reads like a complaint', () => {
    expect(summarizeFfmpegError('opening input\n\nInvalid argument\n')).toBe('Invalid argument');
  });

  it('says nothing when ffmpeg said nothing', () => {
    expect(summarizeFfmpegError('   \n\n')).toBeNull();
  });

  it('does not run on forever', () => {
    expect(summarizeFfmpegError(`Error: ${'x'.repeat(500)}`)?.length).toBe(300);
  });

  it('admits it has no reason rather than offering a stray metadata line', () => {
    // What a process that was killed outright leaves behind: no complaint, just
    // whatever it had already narrated about the streams it opened.
    const output = ['Stream #0:1: Audio: aac', '  handler_name    : SoundHandler'].join('\n');

    expect(summarizeFfmpegError(output)).toBeNull();
  });

  it('sees past the progress ffmpeg writes with carriage returns', () => {
    const output =
      'frame=  181 fps=0.0 q=29.0 size=  0KiB\rframe=  430 fps=416 q=29.0 size= 256KiB\r' +
      'Conversion failed!';

    expect(summarizeFfmpegError(output)).toBe('Conversion failed!');
  });

  it('prefers the complaint over the statistics printed after it', () => {
    const output = ['Error while opening encoder', 'video:82kB audio:3kB', 'kb/s:82.93'].join('\n');

    expect(summarizeFfmpegError(output)).toBe('Error while opening encoder');
  });
});

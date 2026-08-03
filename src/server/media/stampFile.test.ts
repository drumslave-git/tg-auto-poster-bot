import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult } from '../util/exec.js';

/**
 * ffmpeg and ffprobe are the only things this touches, and both are stubbed:
 * the point of these tests is the verdict `stampFile` reaches about a run, not
 * the encoding itself, which is verified against the real binaries separately.
 */
const stub = vi.hoisted(() => ({ runCommand: vi.fn() }));

vi.mock('../util/exec.js', () => ({ runCommand: stub.runCommand }));

const { env } = await import('../env.js');
const { stampFile } = await import('./watermark.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-poster-stamp-test-'));
const placement = { x: 100, y: 100, opacity: 100, scale: 20 };

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function result(patch: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout: '', output: '', timedOut: false, spawnError: null, ...patch };
}

/** ffprobe answers with a size; ffmpeg writes `bytes` to wherever it was told. */
function pipeline({
  encodeCode = 0 as number | null,
  encodeOutput = '',
  bytes = 4096,
  outputProbeFails = false,
}) {
  let encoded = false;

  stub.runCommand.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'ffprobe') {
      // The last argument is the file being measured; after the encode, the
      // only thing measured is the output.
      const measuringOutput = encoded && args.at(-1)!.includes('stamped');
      if (measuringOutput && outputProbeFails) return result({ code: 1, stdout: '' });
      return result({ stdout: '1000,1000\n' });
    }

    encoded = true;
    const target = args.at(-1)!;
    if (bytes > 0) writeFileSync(target, Buffer.alloc(bytes));
    return result({ code: encodeCode, output: encodeOutput });
  });
}

beforeEach(() => {
  stub.runCommand.mockReset();
  // stampFile refuses outright without a watermark to stamp with.
  writeFileSync(env.watermarkPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

describe('stampFile', () => {
  it('accepts a run that finished cleanly and left a playable file', async () => {
    pipeline({});

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped).toMatchObject({ ok: true, bytes: 4096 });
  });

  it('refuses a run that exited non-zero, however many bytes it left behind', async () => {
    // The exact shape of the bug this guards: ffmpeg fails part-way, having
    // already written a megabyte of a file with no moov atom in it.
    pipeline({ encodeCode: 1, encodeOutput: 'Error while decoding stream', bytes: 1_048_576 });

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped).toMatchObject({ ok: false });
    expect(stamped.ok === false && stamped.error).toContain('Error while decoding stream');
  });

  it('blames memory when the encode was killed on a signal', async () => {
    // A null exit code is a process that died on a signal — the OOM killer.
    pipeline({ encodeCode: null, bytes: 1_048_576 });

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped).toMatchObject({ ok: false });
    expect(stamped.ok === false && stamped.error).toMatch(/killed|memory/i);
  });

  it('refuses a file that exited cleanly but cannot be played back', async () => {
    pipeline({ outputProbeFails: true });

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped).toMatchObject({ ok: false });
    expect(stamped.ok === false && stamped.error).toMatch(/cannot be played/i);
  });

  it('refuses an empty output', async () => {
    pipeline({ bytes: 0 });

    expect(await stampFile(path.join(dir, 'in.mp4'), 'video', placement)).toMatchObject({
      ok: false,
    });
  });

  it('refuses a stamped file too large to upload', async () => {
    pipeline({ bytes: 51 * 1024 * 1024 });

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped).toMatchObject({ ok: false });
    expect(stamped.ok === false && stamped.error).toMatch(/may upload/i);
  });

  it('says so plainly when ffmpeg itself is not installed', async () => {
    stub.runCommand.mockImplementation(async (command: string) =>
      command === 'ffprobe'
        ? result({ stdout: '1000,1000\n' })
        : result({ spawnError: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }),
    );

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped.ok === false && stamped.error).toMatch(/ffmpeg is not installed/i);
  });

  it('points at ffprobe when the media cannot even be measured', async () => {
    stub.runCommand.mockResolvedValue(
      result({ spawnError: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }),
    );

    const stamped = await stampFile(path.join(dir, 'in.mp4'), 'video', placement);

    expect(stamped.ok === false && stamped.error).toMatch(/ffprobe/i);
  });
});

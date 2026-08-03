import { describe, expect, it } from 'vitest';
import {
  classifyUpdate,
  parseFfmpegVersion,
  parseYtDlpVersion,
  summarizeYtDlpError,
} from './tools.js';

describe('parseYtDlpVersion', () => {
  it('takes the version yt-dlp prints on its own', () => {
    expect(parseYtDlpVersion('2026.07.21\n')).toBe('2026.07.21');
  });

  it('accepts a nightly build', () => {
    expect(parseYtDlpVersion('2026.07.21.232703')).toBe('2026.07.21.232703');
  });

  it('has nothing to report when the output is empty or wordy', () => {
    expect(parseYtDlpVersion('')).toBeNull();
    expect(parseYtDlpVersion('  \n \n')).toBeNull();
    expect(parseYtDlpVersion('command not found')).toBeNull();
  });
});

describe('parseFfmpegVersion', () => {
  it('reads the version out of the banner', () => {
    const output = [
      'ffmpeg version 6.1.1-alpine Copyright (c) 2000-2023 the FFmpeg developers',
      'built with gcc 13.2.1',
    ].join('\n');
    expect(parseFfmpegVersion(output)).toBe('6.1.1-alpine');
  });

  it('handles a git build string', () => {
    expect(parseFfmpegVersion('ffmpeg version n7.1-3-gabc1234 Copyright (c)')).toBe(
      'n7.1-3-gabc1234',
    );
  });

  it('gives up on output that is not ffmpeg’s banner', () => {
    expect(parseFfmpegVersion('bash: ffmpeg: command not found')).toBeNull();
  });
});

describe('classifyUpdate', () => {
  it('recognises an install that was already current', () => {
    const result = classifyUpdate('yt-dlp is up to date (stable@2026.07.21)', 0);
    expect(result.outcome).toBe('up-to-date');
  });

  it('recognises a completed update and names the new version', () => {
    const output = [
      'Latest version: stable@2026.08.01',
      'Updating to stable@2026.08.01 ...',
      'Updated yt-dlp to stable@2026.08.01',
    ].join('\n');
    const result = classifyUpdate(output, 0);

    expect(result.outcome).toBe('updated');
    expect(result.message).toContain('stable@2026.08.01');
  });

  it('treats a package-managed install as unsupported, not broken', () => {
    const output =
      'ERROR: You installed yt-dlp with a package manager or setup.py; Please use that to update';
    expect(classifyUpdate(output, 1).outcome).toBe('unsupported');
  });

  it('also spots the newer "not updateable" wording', () => {
    expect(classifyUpdate('ERROR: Unable to update: this package is not updateable', 1).outcome).toBe(
      'unsupported',
    );
  });

  it('reports anything else as a failure, in yt-dlp’s words', () => {
    const result = classifyUpdate('ERROR: Unable to write to /usr/bin/yt-dlp', 1);

    expect(result.outcome).toBe('failed');
    expect(result.message).toBe('Unable to write to /usr/bin/yt-dlp');
  });

  it('falls back to the exit code when nothing was said', () => {
    expect(classifyUpdate('', 7)).toEqual({
      outcome: 'failed',
      message: 'yt-dlp -U exited with code 7.',
    });
  });
});

describe('summarizeYtDlpError', () => {
  it('reports the last error line without the prefix', () => {
    const output = ['[youtube] Extracting URL', 'ERROR: [youtube] abc: Video unavailable'].join('\n');
    expect(summarizeYtDlpError(output)).toBe('[youtube] abc: Video unavailable');
  });

  it('drops the bug-report boilerplate', () => {
    const output =
      'ERROR: Unsupported URL: https://example.com/x; please report this issue on https://github.com/yt-dlp/yt-dlp';
    expect(summarizeYtDlpError(output)).toBe('Unsupported URL: https://example.com/x');
  });

  it('falls back to the last thing said when nothing is tagged ERROR', () => {
    expect(summarizeYtDlpError('[generic] nothing to download\n')).toBe(
      '[generic] nothing to download',
    );
  });

  it('says nothing when there was no output', () => {
    expect(summarizeYtDlpError('   \n  \n')).toBeNull();
  });

  it('truncates a wall of text', () => {
    expect(summarizeYtDlpError(`ERROR: ${'x'.repeat(500)}`)).toHaveLength(300);
  });
});

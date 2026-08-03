import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auto-poster-test-'));

// Keep the suite independent of whatever sits in the developer's .env.
process.env.DASHBOARD_PASSWORD = '';
process.env.BOT_TOKEN = '';
process.env.ADMIN_IDS = '';
process.env.ADMIN_ID = '';
process.env.MANAGER_IDS = '';
process.env.TZ_NAME = 'UTC';

/**
 * Both paths under `data/` are fixed in production, so the tests redirect them
 * here rather than through a setting nothing else uses. Setup files run once
 * per test file and vitest gives each file its own module registry, so every
 * file ends up with a private database and a private watermark — and neither
 * one ever touches the real ./data.
 *
 * The factory runs when a test file first imports the env module, long after
 * this file has finished evaluating, so reaching `dir` from it is safe.
 */
vi.mock('../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.js')>();
  return {
    env: {
      ...actual.env,
      databasePath: path.join(dir, 'test.db'),
      watermarkPath: path.join(dir, 'watermark.png'),
    },
  };
});

afterAll(() => {
  // Best effort: Windows refuses to unlink a database whose connection is still
  // open, and the connection lives for the lifetime of the module.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The temp directory is the operating system's problem from here.
  }
});

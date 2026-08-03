import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Runs before the test file's own imports, which matters: `db/index.ts` opens
 * the database as an import side effect, so DATABASE_PATH has to be pointed at
 * a scratch file first. Setup files run once per test file, and vitest gives
 * each file its own module registry, so every file gets a private database.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-auto-poster-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
// Keep the suite independent of whatever sits in the developer's .env.
process.env.DASHBOARD_PASSWORD = '';
process.env.BOT_TOKEN = '';
process.env.ADMIN_IDS = '';
process.env.ADMIN_ID = '';
process.env.MANAGER_IDS = '';
process.env.TZ_NAME = 'UTC';

afterAll(() => {
  // Best effort: Windows refuses to unlink a database whose connection is still
  // open, and the connection lives for the lifetime of the module.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The temp directory is the operating system's problem from here.
  }
});

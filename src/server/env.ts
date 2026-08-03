import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();

/**
 * The running release, read from package.json rather than imported: the build
 * is rooted at `src/`, so the file sits outside what tsc will compile. Never
 * throws — an unreadable package.json is not worth refusing to boot over.
 */
function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `123, 456` → `['123', '456']`. Blank entries are dropped. */
function idList(...values: (string | undefined)[]): string[] {
  const ids = values
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

export const env = {
  version: readVersion(),
  port: Number(process.env.PORT ?? 3000),
  /** Always alongside the app; mount `data/` to keep it across redeploys. */
  databasePath: path.resolve(cwd, 'data/app.db'),
  /**
   * The watermark PNG, beside the database so the one mount keeps both. It is
   * the only setting held as a file: every other one fits in a column.
   */
  watermarkPath: path.resolve(cwd, 'data/watermark.png'),
  /** Optional: when set, every /api call must carry this value. */
  dashboardPassword: process.env.DASHBOARD_PASSWORD?.trim() || null,
  /** Bootstrap values, only used the very first time the DB is created. */
  initialBotToken: process.env.BOT_TOKEN?.trim() || null,
  /** ADMIN_ID is the older single-value name, still accepted. */
  initialAdminIds: idList(process.env.ADMIN_IDS, process.env.ADMIN_ID),
  initialManagerIds: idList(process.env.MANAGER_IDS),
  initialTimezone: process.env.TZ_NAME?.trim() || 'UTC',
  webDist: path.resolve(cwd, 'dist/web'),
  isProduction: process.env.NODE_ENV === 'production',
};

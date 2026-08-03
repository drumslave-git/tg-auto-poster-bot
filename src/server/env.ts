import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();

/** `123, 456` → `['123', '456']`. Blank entries are dropped. */
function idList(...values: (string | undefined)[]): string[] {
  const ids = values
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  /** Always alongside the app; mount `data/` to keep it across redeploys. */
  databasePath: path.resolve(cwd, 'data/app.db'),
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

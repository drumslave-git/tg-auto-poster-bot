import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: path.resolve(cwd, process.env.DATABASE_PATH ?? './data/app.db'),
  /** Optional: when set, every /api call must carry this value. */
  dashboardPassword: process.env.DASHBOARD_PASSWORD?.trim() || null,
  /** Bootstrap values, only used the very first time the DB is created. */
  initialBotToken: process.env.BOT_TOKEN?.trim() || null,
  initialAdminId: process.env.ADMIN_ID?.trim() || null,
  initialTimezone: process.env.TZ_NAME?.trim() || 'UTC',
  webDist: path.resolve(cwd, 'dist/web'),
  isProduction: process.env.NODE_ENV === 'production',
};

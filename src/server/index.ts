import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { api } from './api/routes.js';
import { dashboardAuth } from './api/auth.js';
import { botManager } from './bot/manager.js';
import { startScheduler, stopScheduler } from './bot/scheduler.js';
import { runMigrations } from './db/index.js';
import { env } from './env.js';
import { ensureSettings } from './services/settings.js';

async function main(): Promise<void> {
  runMigrations();
  const settings = ensureSettings();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', dashboardAuth, api);

  if (fs.existsSync(env.webDist)) {
    app.use(express.static(env.webDist));
    // SPA fallback for everything that is not an API route.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(env.webDist, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] unhandled error', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' });
  });

  const server = app.listen(env.port, () => {
    console.log(`[server] dashboard API on http://localhost:${env.port}`);
    if (!fs.existsSync(env.webDist)) {
      console.log('[server] dashboard bundle not built — run "npm run dev:web" or "npm run build:web"');
    }
    if (!env.dashboardPassword) {
      console.warn('[server] DASHBOARD_PASSWORD is not set — the dashboard is unauthenticated');
    }
  });

  await botManager.apply(settings.botToken);
  startScheduler();

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    stopScheduler();
    await botManager.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[server] fatal', error);
  process.exit(1);
});

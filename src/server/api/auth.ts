import type { NextFunction, Request, Response } from 'express';
import { env } from '../env.js';

/**
 * Optional shared-secret gate. Disabled unless DASHBOARD_PASSWORD is set —
 * set it whenever the dashboard is reachable from outside localhost.
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = env.dashboardPassword;
  if (!expected) {
    next();
    return;
  }

  const header = req.header('x-dashboard-password');
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = header ?? bearer ?? '';

  if (provided === expected) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized', authRequired: true });
}

export function authRequired(): boolean {
  return env.dashboardPassword !== null;
}

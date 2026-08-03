import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { authRequired, dashboardAuth } from './auth.js';

// A mutable stand-in, so each test can pick its own password without reloading
// the real env module (which reads process.env once, at import).
vi.mock('../env.js', () => ({ env: { dashboardPassword: null as string | null } }));

function request(headers: Record<string, string> = {}): Request {
  const lookup = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { header: (name: string) => lookup.get(name.toLowerCase()) } as unknown as Request;
}

function response() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

function run(headers?: Record<string, string>) {
  const res = response();
  const next = vi.fn() as unknown as NextFunction;
  dashboardAuth(request(headers), res as unknown as Response, next);
  return { res, next };
}

beforeEach(() => {
  env.dashboardPassword = null;
});

describe('with no password configured', () => {
  it('lets everything through', () => {
    const { res, next } = run();

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('reports that auth is off', () => {
    expect(authRequired()).toBe(false);
  });
});

describe('with a password configured', () => {
  beforeEach(() => {
    env.dashboardPassword = 's3cret';
  });

  it('reports that auth is on', () => {
    expect(authRequired()).toBe(true);
  });

  it('accepts the dedicated header', () => {
    const { next } = run({ 'x-dashboard-password': 's3cret' });

    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts a bearer token, case-insensitively', () => {
    expect(run({ authorization: 'Bearer s3cret' }).next).toHaveBeenCalledOnce();
    expect(run({ authorization: 'bearer s3cret' }).next).toHaveBeenCalledOnce();
  });

  it('accepts a bare authorization value', () => {
    expect(run({ authorization: 's3cret' }).next).toHaveBeenCalledOnce();
  });

  it('prefers the dedicated header over the bearer token', () => {
    const { next } = run({ 'x-dashboard-password': 'wrong', authorization: 'Bearer s3cret' });

    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong password', () => {
    const { res, next } = run({ 'x-dashboard-password': 'nope' });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', authRequired: true });
  });

  it('rejects a request with no credentials at all', () => {
    const { res, next } = run();

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

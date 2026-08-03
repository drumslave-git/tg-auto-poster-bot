import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The real module, re-evaluated so it re-reads the stubbed variables. */
async function loadEnv() {
  vi.resetModules();
  const actual = await vi.importActual<typeof import('./env.js')>('./env.js');
  return actual.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('paths', () => {
  it('keeps the database next to the app, where the volume is mounted', async () => {
    const env = await loadEnv();

    expect(env.databasePath).toBe(path.resolve(process.cwd(), 'data/app.db'));
    expect(env.webDist).toBe(path.resolve(process.cwd(), 'dist/web'));
  });
});

describe('version', () => {
  it('reports the version from package.json', async () => {
    const { version } = JSON.parse(
      await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    expect((await loadEnv()).version).toBe(version);
  });
});

describe('port', () => {
  it('defaults to 3000', async () => {
    vi.stubEnv('PORT', undefined);

    expect((await loadEnv()).port).toBe(3000);
  });

  it('takes the configured one', async () => {
    vi.stubEnv('PORT', '8080');

    expect((await loadEnv()).port).toBe(8080);
  });
});

describe('dashboard password', () => {
  it('is off when unset or blank', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    expect((await loadEnv()).dashboardPassword).toBeNull();

    vi.stubEnv('DASHBOARD_PASSWORD', '   ');
    expect((await loadEnv()).dashboardPassword).toBeNull();
  });

  it('is trimmed when set', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', '  s3cret  ');

    expect((await loadEnv()).dashboardPassword).toBe('s3cret');
  });
});

describe('bootstrap ids', () => {
  it('splits a comma-separated list, trimming the parts', async () => {
    vi.stubEnv('ADMIN_IDS', ' 100 , 200 ');

    expect((await loadEnv()).initialAdminIds).toEqual(['100', '200']);
  });

  it('drops blanks and duplicates', async () => {
    vi.stubEnv('ADMIN_IDS', '100,,100, ,200');

    expect((await loadEnv()).initialAdminIds).toEqual(['100', '200']);
  });

  it('still accepts the older singular ADMIN_ID, alongside the list', async () => {
    vi.stubEnv('ADMIN_IDS', '100');
    vi.stubEnv('ADMIN_ID', '200');

    expect((await loadEnv()).initialAdminIds).toEqual(['100', '200']);
  });

  it('is empty when nothing is configured', async () => {
    vi.stubEnv('ADMIN_IDS', '');
    vi.stubEnv('ADMIN_ID', '');
    vi.stubEnv('MANAGER_IDS', '');

    const env = await loadEnv();

    expect(env.initialAdminIds).toEqual([]);
    expect(env.initialManagerIds).toEqual([]);
  });

  it('reads the managers from their own list', async () => {
    vi.stubEnv('MANAGER_IDS', '300,400');

    expect((await loadEnv()).initialManagerIds).toEqual(['300', '400']);
  });
});

describe('timezone', () => {
  it('falls back to UTC', async () => {
    vi.stubEnv('TZ_NAME', '');

    expect((await loadEnv()).initialTimezone).toBe('UTC');
  });

  it('takes the configured zone, trimmed', async () => {
    vi.stubEnv('TZ_NAME', ' Europe/Berlin ');

    expect((await loadEnv()).initialTimezone).toBe('Europe/Berlin');
  });
});

describe('isProduction', () => {
  it('follows NODE_ENV', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await loadEnv()).isProduction).toBe(true);

    vi.stubEnv('NODE_ENV', 'development');
    expect((await loadEnv()).isProduction).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onDashboardChange } from '../events.js';
import { resetDb } from '../test/db.js';
import {
  ROLES,
  addUser,
  adminCount,
  blocksLastAdmin,
  ensureUsers,
  getUser,
  hasNoUsers,
  isRole,
  listUsers,
  removeUser,
  roleOf,
  setLabel,
  setRole,
  userCount,
} from './users.js';

beforeEach(() => {
  resetDb();
});

describe('isRole', () => {
  it('accepts the two roles', () => {
    expect(ROLES).toEqual(['admin', 'manager']);
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isRole('owner')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(1)).toBe(false);
  });
});

describe('addUser', () => {
  it('stores the role and the label', () => {
    const user = addUser('100', 'admin', '@ada');

    expect(user).toMatchObject({ telegramId: '100', role: 'admin', label: '@ada' });
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('defaults the label to null', () => {
    expect(addUser('100', 'manager').label).toBeNull();
  });

  it('tells the dashboard something changed', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);

    addUser('100', 'manager');

    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe('listUsers', () => {
  it('puts admins first, oldest first within a role', () => {
    addUser('300', 'manager');
    addUser('100', 'admin');
    addUser('200', 'admin');

    expect(listUsers().map((u) => u.telegramId)).toEqual(['100', '200', '300']);
  });
});

describe('lookups', () => {
  it('counts users and admins', () => {
    expect(hasNoUsers()).toBe(true);
    expect(userCount()).toBe(0);

    addUser('100', 'admin');
    addUser('200', 'manager');

    expect(hasNoUsers()).toBe(false);
    expect(userCount()).toBe(2);
    expect(adminCount()).toBe(1);
  });

  it('resolves a role from a string or a number id', () => {
    addUser('100', 'admin');

    expect(roleOf('100')).toBe('admin');
    expect(roleOf(100)).toBe('admin');
  });

  it('returns null for strangers and for a missing id', () => {
    expect(roleOf('999')).toBeNull();
    expect(roleOf(undefined)).toBeNull();
    expect(getUser('999')).toBeUndefined();
  });
});

describe('setRole and setLabel', () => {
  it('changes the role and returns the new row', () => {
    addUser('100', 'manager');

    expect(setRole('100', 'admin')?.role).toBe('admin');
    expect(roleOf('100')).toBe('admin');
  });

  it('returns undefined for an unknown user', () => {
    expect(setRole('999', 'admin')).toBeUndefined();
  });

  it('updates the cached label', () => {
    addUser('100', 'manager', '@old');

    setLabel('100', '@new');
    expect(getUser('100')?.label).toBe('@new');

    setLabel('100', null);
    expect(getUser('100')?.label).toBeNull();
  });
});

describe('removeUser', () => {
  it('reports whether a row went away', () => {
    addUser('100', 'admin');

    expect(removeUser('100')).toBe(true);
    expect(removeUser('100')).toBe(false);
    expect(userCount()).toBe(0);
  });
});

describe('blocksLastAdmin', () => {
  it('allows changes to managers', () => {
    addUser('100', 'admin');
    addUser('200', 'manager');

    expect(blocksLastAdmin('200', null)).toBeNull();
    expect(blocksLastAdmin('200', 'admin')).toBeNull();
  });

  it('allows an unknown id through', () => {
    expect(blocksLastAdmin('999', null)).toBeNull();
  });

  it('allows a no-op promotion of the last admin', () => {
    addUser('100', 'admin');

    expect(blocksLastAdmin('100', 'admin')).toBeNull();
  });

  it('refuses to delete the last admin', () => {
    addUser('100', 'admin');

    expect(blocksLastAdmin('100', null)).toMatch(/remove the last admin/);
  });

  it('refuses to demote the last admin', () => {
    addUser('100', 'admin');

    expect(blocksLastAdmin('100', 'manager')).toMatch(/demote the last admin/);
  });

  it('lets an admin go once there is another one', () => {
    addUser('100', 'admin');
    addUser('200', 'admin');

    expect(blocksLastAdmin('100', null)).toBeNull();
    expect(blocksLastAdmin('100', 'manager')).toBeNull();
  });
});

describe('ensureUsers', () => {
  it('does nothing when the table already has someone', () => {
    addUser('100', 'admin');

    ensureUsers();

    expect(userCount()).toBe(1);
  });

  it('does nothing when no bootstrap ids are configured', () => {
    ensureUsers();

    expect(userCount()).toBe(0);
  });

  it('seeds the ids from the environment on an empty table', async () => {
    vi.stubEnv('ADMIN_IDS', '100, 200');
    vi.stubEnv('MANAGER_IDS', '300,100');
    vi.resetModules();

    // Re-imported so env.ts re-reads the stubbed variables. The scratch database
    // is a file, so the fresh module graph opens the very same one.
    const users = await import('./users.js');
    users.ensureUsers();

    // An id listed as both admin and manager stays an admin.
    const seeded = users
      .listUsers()
      .map((u) => `${u.telegramId}:${u.role}`)
      .sort();
    expect(seeded).toEqual(['100:admin', '200:admin', '300:manager']);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

import { and, asc, count, eq, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, type Role, type User } from '../db/schema.js';
import { env } from '../env.js';

export const ROLES: Role[] = ['admin', 'manager'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

/** Seeds the bootstrap ids from env the first time the table is empty. */
export function ensureUsers(): void {
  if (userCount() > 0) return;

  const seed: { telegramId: string; role: Role }[] = [
    ...env.initialAdminIds.map((telegramId) => ({ telegramId, role: 'admin' as const })),
    ...env.initialManagerIds.map((telegramId) => ({ telegramId, role: 'manager' as const })),
  ];
  if (seed.length === 0) return;

  // Later duplicates lose, so an id listed as both admin and manager stays admin.
  db.insert(users).values(seed).onConflictDoNothing().run();
}

export function listUsers(): User[] {
  return db.select().from(users).orderBy(asc(users.role), asc(users.createdAt)).all();
}

export function getUser(telegramId: string): User | undefined {
  return db.select().from(users).where(eq(users.telegramId, telegramId)).get();
}

export function roleOf(telegramId: string | number | undefined): Role | null {
  if (telegramId === undefined) return null;
  return getUser(String(telegramId))?.role ?? null;
}

export function userCount(): number {
  return db.select({ value: count() }).from(users).get()?.value ?? 0;
}

export function adminCount(): number {
  return db.select({ value: count() }).from(users).where(eq(users.role, 'admin')).get()?.value ?? 0;
}

/** True while nobody is configured — the bot then tells callers their own id. */
export function hasNoUsers(): boolean {
  return userCount() === 0;
}

export function addUser(telegramId: string, role: Role, label?: string | null): User {
  return db
    .insert(users)
    .values({ telegramId, role, label: label ?? null, createdAt: new Date() })
    .returning()
    .get();
}

export function setRole(telegramId: string, role: Role): User | undefined {
  db.update(users).set({ role }).where(eq(users.telegramId, telegramId)).run();
  return getUser(telegramId);
}

export function setLabel(telegramId: string, label: string | null): void {
  db.update(users).set({ label }).where(eq(users.telegramId, telegramId)).run();
}

export function removeUser(telegramId: string): boolean {
  return db.delete(users).where(eq(users.telegramId, telegramId)).run().changes > 0;
}

/**
 * Guards against locking everyone out of the bot: the last admin can neither be
 * deleted nor demoted. Returns an error message, or null when the change is safe.
 */
export function blocksLastAdmin(telegramId: string, nextRole: Role | null): string | null {
  const current = getUser(telegramId);
  if (!current || current.role !== 'admin') return null;
  if (nextRole === 'admin') return null;

  const otherAdmins =
    db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), ne(users.telegramId, telegramId)))
      .get()?.value ?? 0;

  if (otherAdmins > 0) return null;
  return nextRole === null
    ? 'Cannot remove the last admin — add another admin first.'
    : 'Cannot demote the last admin — promote someone else first.';
}

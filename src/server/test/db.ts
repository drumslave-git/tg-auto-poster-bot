import { db, runMigrations } from '../db/index.js';
import { channels, posts, settings, users } from '../db/schema.js';

let migrated = false;

/**
 * Empties the scratch database, migrating it on first use. Call it from
 * `beforeEach` in any test that touches the database.
 *
 * Post ids keep climbing (the column is AUTOINCREMENT), so ids never repeat
 * across tests — module-level caches keyed by post id cannot leak between them.
 */
export function resetDb(): void {
  if (!migrated) {
    runMigrations();
    migrated = true;
  }
  db.delete(posts).run();
  db.delete(users).run();
  db.delete(channels).run();
  db.delete(settings).run();
}

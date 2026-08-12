import type { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite's DatabaseSync has no built-in .transaction() helper (unlike
 * better-sqlite3) — this is a thin BEGIN IMMEDIATE / COMMIT / ROLLBACK
 * wrapper. BEGIN IMMEDIATE (not plain BEGIN) acquires the write lock
 * upfront rather than lazily on the first write.
 *
 * Not nestable: callers composing several repository writes into one atomic
 * unit (e.g. placeGrid.ts) call this ONCE at the composite boundary. The
 * individual repository functions invoked inside `fn` must stay plain
 * autocommit-style statements and must not start their own transaction.
 */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

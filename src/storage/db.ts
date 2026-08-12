import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SCHEMA_SQL } from './schema.js';

// node:sqlite must be imported with the "node:" prefix — Node's own loader
// rejects the bare "sqlite" specifier for this module. Vite/vite-node's
// import resolution strips that prefix before checking Node's builtin list
// (which is why `import { DatabaseSync } from 'node:sqlite'` fails to
// resolve under vitest), so it's loaded via a real CJS require instead,
// which goes through Node's own module loader unmodified.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * Uses Node's built-in node:sqlite (DatabaseSync) rather than better-sqlite3
 * (CLAUDE.md's originally documented choice): better-sqlite3@13 segfaults on
 * this environment (confirmed with both the prebuilt binary and a from-source
 * rebuild; node:sqlite works fine here). Foreign keys are on by default.
 * Defaults to an in-memory database (tests); pass a file path for real use.
 */
export function openDatabase(path: string = ':memory:'): DatabaseSyncType {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  return db;
}

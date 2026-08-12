import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { runInTransaction } from '../../src/storage/transaction.js';

function countRows(db: ReturnType<typeof openDatabase>): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM t').get();
  return row ? (row.count as number) : 0;
}

describe('runInTransaction', () => {
  it('commits all writes when fn succeeds', () => {
    const db = openDatabase();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');

    runInTransaction(db, () => {
      db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
      db.prepare('INSERT INTO t (name) VALUES (?)').run('b');
    });

    expect(countRows(db)).toBe(2);
  });

  it('rolls back ALL writes when fn throws partway through, not just the failing statement', () => {
    const db = openDatabase();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('existing');

    expect(() => {
      runInTransaction(db, () => {
        db.prepare('INSERT INTO t (name) VALUES (?)').run('new-1');
        db.prepare('INSERT INTO t (name) VALUES (?)').run('existing'); // UNIQUE violation
      });
    }).toThrow();

    const rows = db.prepare('SELECT name FROM t ORDER BY id').all();
    expect(rows.map((r) => r.name)).toEqual(['existing']); // 'new-1' rolled back too
  });

  it('propagates the original error after rolling back', () => {
    const db = openDatabase();
    expect(() =>
      runInTransaction(db, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('returns the value produced by fn on success', () => {
    const db = openDatabase();
    const result = runInTransaction(db, () => 42);
    expect(result).toBe(42);
  });
});

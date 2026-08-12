import type { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../config/schema.js';
import { ConfigError } from '../config/errors.js';
import type { Config } from '../config/types.js';

/** MVP §10: one immutable config snapshot per deal, taken at GRID_PLACED, so later config edits don't affect an active deal. */
export function insertConfigSnapshot(
  db: DatabaseSync,
  dealId: string,
  config: Config,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO config_snapshot (deal_id, config_json, created_at) VALUES (@dealId, @configJson, @createdAt)`,
  ).run({ dealId, configJson: JSON.stringify(config), createdAt });
}

/**
 * Re-validates through configSchema on read rather than trusting a plain
 * JSON.parse + cast. The write side only ever stores an already-validated
 * Config, so a healthy round-trip is safe either way — this is cheap
 * insurance against a corrupted/tampered snapshot on disk, not a guard
 * against anything this module itself can produce.
 */
export function getConfigSnapshot(db: DatabaseSync, dealId: string): Config | null {
  const row = db
    .prepare('SELECT config_json FROM config_snapshot WHERE deal_id = @dealId')
    .get({ dealId });
  if (!row) return null;

  const parsed: unknown = JSON.parse(row.config_json as string);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw ConfigError.fromZodError(result.error, `config_snapshot for deal ${dealId}`);
  }
  return result.data;
}

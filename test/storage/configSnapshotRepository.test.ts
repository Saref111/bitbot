import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal } from '../../src/storage/dealRepository.js';
import {
  getConfigSnapshot,
  insertConfigSnapshot,
} from '../../src/storage/configSnapshotRepository.js';
import { ConfigError } from '../../src/config/errors.js';
import { buildConfig } from '../helpers/buildConfig.js';

describe('configSnapshotRepository', () => {
  it('round-trips the full Config object (MVP §10: config at deal start, immune to later config edits)', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    const config = buildConfig({ grid: { orders: 14, overlap_pct: 35 } });
    insertConfigSnapshot(db, 'deal-1', config, 1000);

    expect(getConfigSnapshot(db, 'deal-1')).toEqual(config);
  });

  it('returns null when a deal has no snapshot yet', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    expect(getConfigSnapshot(db, 'deal-1')).toBeNull();
  });

  it('rejects a second snapshot for the same deal (one config per deal, MVP §10)', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    insertConfigSnapshot(db, 'deal-1', buildConfig(), 1000);

    expect(() => {
      insertConfigSnapshot(db, 'deal-1', buildConfig(), 2000);
    }).toThrow();
  });

  it('throws a ConfigError (not a raw parse/cast surprise) on a corrupted snapshot', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    // Bypasses insertConfigSnapshot to simulate on-disk corruption / a bug in
    // some future writer: valid JSON, but not a valid Config (missing fields).
    db.prepare(
      'INSERT INTO config_snapshot (deal_id, config_json, created_at) VALUES (@dealId, @configJson, @createdAt)',
    ).run({
      dealId: 'deal-1',
      configJson: JSON.stringify({ symbol: 'ETH/USDT:USDT' }),
      createdAt: 1000,
    });

    expect(() => getConfigSnapshot(db, 'deal-1')).toThrow(ConfigError);
  });
});

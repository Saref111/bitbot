import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal, updateDeal } from '../../src/storage/dealRepository.js';
import { insertGridOrders, updateGridOrderStatus } from '../../src/storage/gridOrderRepository.js';
import { insertExitOrder } from '../../src/storage/exitOrderRepository.js';
import { insertConfigSnapshot } from '../../src/storage/configSnapshotRepository.js';
import { restoreDeal } from '../../src/storage/restoreDeal.js';
import { buildConfig } from '../helpers/buildConfig.js';

describe('restoreDeal — composite load', () => {
  it('reconstructs deal + gridOrders + exitOrders + config from a single dealId', () => {
    const db = openDatabase();
    const config = buildConfig({ grid: { orders: 2, partial_placement: null } });

    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    updateDeal(db, 'deal-1', { pEntry: 1901.54, filledRungsCount: 1 });
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1874.16, size: 0.019, clientOrderId: 'deal-1-2' },
      ],
      1000,
    );
    updateGridOrderStatus(db, 'deal-1-1', { status: 'filled', filledAt: 1100, fillPrice: 1897.74 });
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      createdAt: 1100,
    });
    insertConfigSnapshot(db, 'deal-1', config, 1000);

    const restored = restoreDeal(db, 'deal-1');

    expect(restored?.deal.status).toBe('ACTIVE');
    expect(restored?.deal.pEntry).toBeCloseTo(1901.54, 9);
    expect(restored?.gridOrders).toHaveLength(2);
    expect(restored?.gridOrders[0]?.status).toBe('filled');
    expect(restored?.gridOrders[1]?.status).toBe('pending');
    expect(restored?.exitOrders).toHaveLength(1);
    expect(restored?.exitOrders[0]?.type).toBe('tp');
    expect(restored?.config).toEqual(config);
  });

  it('returns null for a deal that does not exist', () => {
    const db = openDatabase();
    expect(restoreDeal(db, 'nope')).toBeNull();
  });
});

describe('restoreDeal — survives a real restart (new connection to the same file)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads back everything written before the process "restarted"', () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bitbot-test-'));
    const dbPath = path.join(tmpDir, 'bitbot.db');
    const config = buildConfig({ grid: { orders: 2, partial_placement: null } });

    // "Before restart": open, write, close.
    const before = openDatabase(dbPath);
    insertDeal(before, {
      id: 'deal-1',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    updateDeal(before, 'deal-1', { pEntry: 1901.54 });
    insertGridOrders(
      before,
      'deal-1',
      [{ rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' }],
      1000,
    );
    insertConfigSnapshot(before, 'deal-1', config, 1000);
    before.close();

    // "After restart": a fresh connection to the same file, nothing shared in memory.
    const after = openDatabase(dbPath);
    const restored = restoreDeal(after, 'deal-1');

    expect(restored?.deal.status).toBe('GRID_PLACED');
    expect(restored?.deal.pEntry).toBeCloseTo(1901.54, 9);
    expect(restored?.gridOrders).toHaveLength(1);
    expect(restored?.config).toEqual(config);
    after.close();
  });
});

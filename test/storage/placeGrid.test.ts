import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal, insertDeal } from '../../src/storage/dealRepository.js';
import { getGridOrdersByDeal } from '../../src/storage/gridOrderRepository.js';
import { getConfigSnapshot } from '../../src/storage/configSnapshotRepository.js';
import { placeGrid } from '../../src/storage/placeGrid.js';
import { buildConfig } from '../helpers/buildConfig.js';

describe('placeGrid — atomic GRID_PLACED write (MVP §5)', () => {
  it('commits the deal update + all grid orders + config snapshot together', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    const config = buildConfig({ grid: { orders: 2, partial_placement: null } });

    placeGrid(db, {
      dealId: 'deal-1',
      pEntry: 1901.54,
      rungs: [
        { rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1874.16, size: 0.019, clientOrderId: 'deal-1-2' },
      ],
      config,
      at: 2000,
    });

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('GRID_PLACED');
    expect(deal?.pEntry).toBeCloseTo(1901.54, 9);
    expect(getGridOrdersByDeal(db, 'deal-1')).toHaveLength(2);
    expect(getConfigSnapshot(db, 'deal-1')).toEqual(config);
  });

  it('rolls back the WHOLE write if any statement fails partway through (crash-safety)', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    const config = buildConfig({ grid: { orders: 4 } });

    expect(() => {
      placeGrid(db, {
        dealId: 'deal-1',
        pEntry: 1901.54,
        rungs: [
          { rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' },
          { rungIndex: 2, price: 1874.16, size: 0.019, clientOrderId: 'deal-1-2' },
          { rungIndex: 3, price: 1839.67, size: 0.02, clientOrderId: 'deal-1-3' },
          // duplicate rungIndex 3 -> UNIQUE(deal_id, rung_index) violation on the 4th insert
          { rungIndex: 3, price: 1800, size: 0.02, clientOrderId: 'deal-1-4' },
        ],
        config,
        at: 2000,
      });
    }).toThrow();

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('WAITING_SIGNAL'); // untouched, NOT GRID_PLACED
    expect(deal?.pEntry).toBeNull();
    expect(getGridOrdersByDeal(db, 'deal-1')).toHaveLength(0); // none of the 3 valid rungs stuck either
    expect(getConfigSnapshot(db, 'deal-1')).toBeNull();
  });
});

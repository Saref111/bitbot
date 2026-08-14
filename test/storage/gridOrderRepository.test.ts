import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal } from '../../src/storage/dealRepository.js';
import {
  getGridOrdersByDeal,
  insertGridOrders,
  updateGridOrderStatus,
} from '../../src/storage/gridOrderRepository.js';

function seedDeal(db: DatabaseSync, id = 'deal-1'): void {
  insertDeal(db, {
    id,
    status: 'GRID_PLACED',
    direction: 'long',
    depositUsdt: 200,
    openedAt: 1000,
  });
}

describe('gridOrderRepository', () => {
  it('bulk-inserts the whole grid as pending (MVP §5: computed once, all pending upfront)', () => {
    const db = openDatabase();
    seedDeal(db);

    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' },
        { rungIndex: 2, price: 1874.16, size: 0.019, clientOrderId: 'deal-1-2' },
      ],
      2000,
    );

    const orders = getGridOrdersByDeal(db, 'deal-1');
    expect(orders).toHaveLength(2);
    expect(orders[0]).toEqual({
      id: expect.any(Number) as number,
      dealId: 'deal-1',
      rungIndex: 1,
      price: 1897.74,
      size: 0.018,
      clientOrderId: 'deal-1-1',
      status: 'pending',
      createdAt: 2000,
      placedAt: null,
      filledAt: null,
      cancelledAt: null,
      fillPrice: null,
      filledSize: 0,
    });
  });

  it('returns results ordered by rungIndex regardless of insert order', () => {
    const db = openDatabase();
    seedDeal(db);
    insertGridOrders(
      db,
      'deal-1',
      [
        { rungIndex: 2, price: 1874.16, size: 0.019, clientOrderId: 'deal-1-2' },
        { rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' },
      ],
      2000,
    );

    const orders = getGridOrdersByDeal(db, 'deal-1');
    expect(orders.map((o) => o.rungIndex)).toEqual([1, 2]);
  });

  it('moves a rung through pending -> placed -> filled with timestamps and fill price', () => {
    const db = openDatabase();
    seedDeal(db);
    insertGridOrders(
      db,
      'deal-1',
      [{ rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' }],
      2000,
    );

    updateGridOrderStatus(db, 'deal-1-1', { status: 'placed', placedAt: 2100 });
    expect(getGridOrdersByDeal(db, 'deal-1')[0]?.status).toBe('placed');

    updateGridOrderStatus(db, 'deal-1-1', { status: 'filled', filledAt: 2200, fillPrice: 1897.7 });
    const order = getGridOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('filled');
    expect(order?.placedAt).toBe(2100);
    expect(order?.filledAt).toBe(2200);
    expect(order?.fillPrice).toBeCloseTo(1897.7, 9);
  });

  it('supports cancelling a pending rung', () => {
    const db = openDatabase();
    seedDeal(db);
    insertGridOrders(
      db,
      'deal-1',
      [{ rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' }],
      2000,
    );

    updateGridOrderStatus(db, 'deal-1-1', { status: 'cancelled', cancelledAt: 2050 });
    const order = getGridOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('cancelled');
    expect(order?.cancelledAt).toBe(2050);
  });

  it('tracks partial-fill progress via filledSize while still placed (MVP: real limit orders can fill incrementally)', () => {
    const db = openDatabase();
    seedDeal(db);
    insertGridOrders(
      db,
      'deal-1',
      [{ rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' }],
      2000,
    );
    updateGridOrderStatus(db, 'deal-1-1', { status: 'placed', placedAt: 2100 });

    updateGridOrderStatus(db, 'deal-1-1', { status: 'placed', filledSize: 0.007 });
    const order = getGridOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('placed');
    expect(order?.filledSize).toBeCloseTo(0.007, 9);
  });

  it('scopes results to the given deal', () => {
    const db = openDatabase();
    seedDeal(db, 'deal-1');
    seedDeal(db, 'deal-2');
    insertGridOrders(
      db,
      'deal-1',
      [{ rungIndex: 1, price: 1897.74, size: 0.018, clientOrderId: 'deal-1-1' }],
      2000,
    );
    insertGridOrders(
      db,
      'deal-2',
      [{ rungIndex: 1, price: 100, size: 1, clientOrderId: 'deal-2-1' }],
      2000,
    );

    expect(getGridOrdersByDeal(db, 'deal-1')).toHaveLength(1);
    expect(getGridOrdersByDeal(db, 'deal-1')[0]?.clientOrderId).toBe('deal-1-1');
  });
});

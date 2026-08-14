import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal } from '../../src/storage/dealRepository.js';
import {
  getExitOrdersByDeal,
  insertExitOrder,
  updateExitOrderStatus,
} from '../../src/storage/exitOrderRepository.js';

function seedDeal(db: DatabaseSync): void {
  insertDeal(db, {
    id: 'deal-1',
    status: 'ACTIVE',
    direction: 'long',
    depositUsdt: 200,
    openedAt: 1000,
  });
}

describe('exitOrderRepository', () => {
  it('round-trips a newly inserted TP order', () => {
    const db = openDatabase();
    seedDeal(db);

    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      amount: 0.03,
      createdAt: 2000,
    });

    const orders = getExitOrdersByDeal(db, 'deal-1');
    expect(orders).toEqual([
      {
        id: expect.any(Number) as number,
        dealId: 'deal-1',
        type: 'tp',
        clientOrderId: 'deal-1-tp',
        price: 1917.6,
        amount: 0.03,
        status: 'placed',
        createdAt: 2000,
        filledAt: null,
        cancelledAt: null,
        filledSize: 0,
      },
    ]);
  });

  it('supports an SL order alongside a TP order for the same deal', () => {
    const db = openDatabase();
    seedDeal(db);
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      amount: 0.03,
      createdAt: 2000,
    });
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'sl',
      clientOrderId: 'deal-1-sl',
      price: 1800,
      amount: 0.03,
      createdAt: 2000,
    });

    const orders = getExitOrdersByDeal(db, 'deal-1');
    expect(orders.map((o) => o.type).sort()).toEqual(['sl', 'tp']);
  });

  it('moves an exit order from placed to filled with a timestamp', () => {
    const db = openDatabase();
    seedDeal(db);
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      amount: 0.03,
      createdAt: 2000,
    });

    updateExitOrderStatus(db, 'deal-1-tp', { status: 'filled', filledAt: 3000 });

    const order = getExitOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('filled');
    expect(order?.filledAt).toBe(3000);
  });

  it('supports cancelling an exit order (e.g. moved to a new price after averaging)', () => {
    const db = openDatabase();
    seedDeal(db);
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      amount: 0.03,
      createdAt: 2000,
    });

    updateExitOrderStatus(db, 'deal-1-tp', { status: 'cancelled', cancelledAt: 2500 });

    const order = getExitOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('cancelled');
    expect(order?.cancelledAt).toBe(2500);
  });

  it('tracks partial-fill progress via filledSize without changing status', () => {
    const db = openDatabase();
    seedDeal(db);
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'tp',
      clientOrderId: 'deal-1-tp',
      price: 1917.6,
      amount: 0.03,
      createdAt: 2000,
    });

    updateExitOrderStatus(db, 'deal-1-tp', { status: 'placed', filledSize: 0.01 });

    const order = getExitOrdersByDeal(db, 'deal-1')[0];
    expect(order?.status).toBe('placed');
    expect(order?.filledSize).toBeCloseTo(0.01, 9);
  });
});

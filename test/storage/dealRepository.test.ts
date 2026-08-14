import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import {
  getDeal,
  getMostRecentClosedDeal,
  insertDeal,
  updateDeal,
} from '../../src/storage/dealRepository.js';

describe('dealRepository', () => {
  it('round-trips a newly inserted deal', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    expect(getDeal(db, 'deal-1')).toEqual({
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      pEntry: null,
      filledRungsCount: 0,
      depositUsdt: 200,
      closeReason: null,
      openedAt: 1000,
      closedAt: null,
      netProfit: null,
    });
  });

  it('returns null for an unknown deal id', () => {
    const db = openDatabase();
    expect(getDeal(db, 'nope')).toBeNull();
  });

  it('updates status and pEntry on a GRID_PLACED transition', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    updateDeal(db, 'deal-1', { status: 'GRID_PLACED', pEntry: 1901.54 });

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('GRID_PLACED');
    expect(deal?.pEntry).toBeCloseTo(1901.54, 9);
  });

  it('updates filledRungsCount and depositUsdt independently, without disturbing other fields', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    updateDeal(db, 'deal-1', { filledRungsCount: 3 });
    expect(getDeal(db, 'deal-1')?.filledRungsCount).toBe(3);

    updateDeal(db, 'deal-1', { depositUsdt: 240 });
    const deal = getDeal(db, 'deal-1');
    expect(deal?.depositUsdt).toBe(240);
    expect(deal?.filledRungsCount).toBe(3);
  });

  it('sets closeReason and closedAt on SETTLING', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    updateDeal(db, 'deal-1', { status: 'SETTLING', closeReason: 'tp', closedAt: 5000 });

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');
    expect(deal?.closedAt).toBe(5000);
  });

  it('is a no-op when the patch is empty', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    expect(() => {
      updateDeal(db, 'deal-1', {});
    }).not.toThrow();
    expect(getDeal(db, 'deal-1')?.status).toBe('WAITING_SIGNAL');
  });

  it('supports short direction (storage is direction-agnostic even though projectGrid/decide defer it)', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'WAITING_SIGNAL',
      direction: 'short',
      depositUsdt: 200,
      openedAt: 1000,
    });
    expect(getDeal(db, 'deal-1')?.direction).toBe('short');
  });

  it('sets and clears netProfit independently of other fields', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });

    updateDeal(db, 'deal-1', {
      status: 'SETTLING',
      closeReason: 'tp',
      closedAt: 5000,
      netProfit: 12.5,
    });
    expect(getDeal(db, 'deal-1')?.netProfit).toBeCloseTo(12.5, 9);

    updateDeal(db, 'deal-1', { netProfit: null });
    const deal = getDeal(db, 'deal-1');
    expect(deal?.netProfit).toBeNull();
    expect(deal?.status).toBe('SETTLING'); // untouched by the netProfit-only patch
  });
});

describe('getMostRecentClosedDeal', () => {
  it('returns null when no deal has ever closed', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    expect(getMostRecentClosedDeal(db)).toBeNull();
  });

  it('picks the deal with the latest closedAt, not insertion order', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-older',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    updateDeal(db, 'deal-older', { status: 'SETTLING', closeReason: 'tp', closedAt: 9000 });

    insertDeal(db, {
      id: 'deal-newer',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 210,
      openedAt: 2000,
    });
    updateDeal(db, 'deal-newer', { status: 'SETTLING', closeReason: 'tp', closedAt: 5000 });

    // deal-older closed LATER in wall-clock time despite starting first.
    expect(getMostRecentClosedDeal(db)?.id).toBe('deal-older');
  });

  it('includes HALTED deals — callers decide whether to trust them', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    updateDeal(db, 'deal-1', { status: 'HALTED', closeReason: 'error', closedAt: 3000 });
    expect(getMostRecentClosedDeal(db)?.status).toBe('HALTED');
  });
});

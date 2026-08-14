import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal, updateDeal } from '../../src/storage/dealRepository.js';
import { resolveDepositUsdt } from '../../src/orchestrator/resolveDeposit.js';
import { buildConfig } from '../helpers/buildConfig.js';

function config() {
  return buildConfig({ deposit_usdt: 200 });
}

describe('resolveDepositUsdt — MVP §7 reinvest chain', () => {
  it('falls back to config.deposit_usdt when no deal has ever closed', () => {
    const db = openDatabase();
    expect(resolveDepositUsdt(db, config())).toBe(200);
  });

  it('grows by reinvest_pct of netProfit after a profitable SETTLING deal', () => {
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
      netProfit: 50,
    });

    // reinvest_pct defaults to 20 in buildConfig -> 200 + 0.2*50 = 210
    expect(resolveDepositUsdt(db, config())).toBeCloseTo(210, 9);
  });

  it('does not shrink the deposit on a loss — carries the base forward unchanged', () => {
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
      closeReason: 'sl',
      closedAt: 5000,
      netProfit: -30,
    });

    expect(resolveDepositUsdt(db, config())).toBeCloseTo(200, 9);
  });

  it('carries the base forward unchanged when netProfit was never computed (null)', () => {
    const db = openDatabase();
    insertDeal(db, {
      id: 'deal-1',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 1000,
    });
    updateDeal(db, 'deal-1', { status: 'SETTLING', closeReason: 'runaway', closedAt: 5000 });

    expect(resolveDepositUsdt(db, config())).toBeCloseTo(200, 9);
  });

  it('breaks the chain on a HALTED most-recent deal, even if an EARLIER deal was profitable SETTLING', () => {
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
      netProfit: 50,
    });

    insertDeal(db, {
      id: 'deal-2',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 210,
      openedAt: 6000,
    });
    updateDeal(db, 'deal-2', { status: 'HALTED', closeReason: 'error', closedAt: 9000 });

    // Must NOT be 210 (deal-2's own deposit) and must NOT skip back to
    // deal-1's grown 210 either — falls all the way to the static config.
    expect(resolveDepositUsdt(db, config())).toBe(200);
  });

  it('chains across multiple profitable deals in sequence', () => {
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
      netProfit: 50,
    });
    // deal-2 itself would have been opened with depositUsdt=210 (this test
    // seeds that directly rather than driving runDeal end-to-end).
    insertDeal(db, {
      id: 'deal-2',
      status: 'ACTIVE',
      direction: 'long',
      depositUsdt: 210,
      openedAt: 6000,
    });
    updateDeal(db, 'deal-2', {
      status: 'SETTLING',
      closeReason: 'tp',
      closedAt: 9000,
      netProfit: 20,
    });

    // 210 + 0.2*20 = 214
    expect(resolveDepositUsdt(db, config())).toBeCloseTo(214, 9);
  });
});

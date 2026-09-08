import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileExitPrices } from '../../src/replay/exitReconciliation.js';
import { parseTelegramEvents } from '../../src/replay/telegramParser.js';
import type { ExampleExchangeEvent } from '../../src/replay/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures');

function orderFilled(dealId: string, rung: number, sumBase: number, avgPrice: number): ExampleExchangeEvent {
  return {
    type: 'orderFilled',
    dealId,
    timestamp: rung * 1000,
    rung,
    rungTotal: 14,
    sumBase,
    sumBaseAsset: 'ETH',
    notionalUsdt: sumBase * avgPrice,
    avgPrice,
  };
}

function dealClosed(dealId: string, profitUsdt: number, closeReason: string): ExampleExchangeEvent {
  return {
    type: 'dealClosed',
    dealId,
    timestamp: 999_000,
    filledRungs: 1,
    rungTotal: 14,
    durationMs: 1000,
    profitUsdt,
    feeUsdt: 0.01,
    closeReason,
  };
}

const TAKE_PROFIT_PCT = 0.9;
const TICK_SIZE = 0.01;

describe('reconcileExitPrices — synthetic', () => {
  it('reports withinTolerance for a single-fill deal that closed exactly on target', () => {
    const avg = 2000;
    const size = 0.02;
    const profit = avg * (TAKE_PROFIT_PCT / 100) * size; // exact target, no noise
    const events = [orderFilled('d1', 1, size, avg), dealClosed('d1', profit, 'тейк-профітом')];

    const report = reconcileExitPrices(events, TAKE_PROFIT_PCT, TICK_SIZE, 1);

    expect(report.deals).toHaveLength(1);
    expect(report.deals[0]?.withinTolerance).toBe(true);
    expect(report.deals[0]?.diffTicks).toBeCloseTo(0, 6);
    expect(report.matchedCount).toBe(1);
    expect(report.totalCount).toBe(1);
  });

  it('uses the LAST (highest-rung) orderFilled event, not the first', () => {
    const events = [
      orderFilled('d1', 1, 0.01, 2000), // stale, should be ignored
      orderFilled('d1', 2, 0.02, 1950), // final cumulative avg/sum
      dealClosed('d1', 1950 * (TAKE_PROFIT_PCT / 100) * 0.02, 'тейк-профітом'),
    ];

    const report = reconcileExitPrices(events, TAKE_PROFIT_PCT, TICK_SIZE, 1);

    expect(report.deals[0]?.avgEntryPrice).toBe(1950);
    expect(report.deals[0]?.totalSize).toBe(0.02);
  });

  it('ignores deals closed for a reason other than take-profit', () => {
    const events = [
      orderFilled('d1', 1, 0.02, 2000),
      dealClosed('d1', -5, 'стоп-лосом'), // way off target, but not a TP close
    ];

    const report = reconcileExitPrices(events, TAKE_PROFIT_PCT, TICK_SIZE, 1);

    expect(report.deals).toHaveLength(0);
    expect(report.totalCount).toBe(0);
  });

  it('throws when a TP-closed deal has no orderFilled events at all', () => {
    const events = [dealClosed('d1', 1, 'тейк-профітом')];

    expect(() => reconcileExitPrices(events, TAKE_PROFIT_PCT, TICK_SIZE, 1)).toThrow(/d1/);
  });

  it('flags a deal outside the tick tolerance', () => {
    const avg = 2000;
    const size = 0.02;
    const profit = avg * (TAKE_PROFIT_PCT / 100) * size + 10; // way off target
    const events = [orderFilled('d1', 1, size, avg), dealClosed('d1', profit, 'тейк-профітом')];

    const report = reconcileExitPrices(events, TAKE_PROFIT_PCT, TICK_SIZE, 1);

    expect(report.deals[0]?.withinTolerance).toBe(false);
    expect(report.matchedCount).toBe(0);
  });
});

describe('reconcileExitPrices — real fixture, all 35 take-profit-closed deals (Sprint 3 Task F)', () => {
  it('every real TP-closed deal implies an exit price within the measured tolerance of the 0.9% target', () => {
    const html = readFileSync(join(FIXTURES_DIR, 'telegram-data/messages-long.html'), 'utf-8');
    const { events, errors } = parseTelegramEvents(html);
    expect(errors).toEqual([]);

    // Calibrated from the actual measured diff across all 35 real
    // TP-closed deals in the fixture: diffTicks ranges from -0.97 to
    // -0.004 (always slightly negative, never exceeding 1 tick) —
    // bitbot's price-based (not leveraged-ROI) take-profit model is
    // exactly consistent with real recorded profit. Comfortable headroom
    // over that measured max, not guessed upfront.
    const TOLERANCE_TICKS = 1.5;
    const report = reconcileExitPrices(events, 0.9, 0.01, TOLERANCE_TICKS);

    expect(report.totalCount).toBe(35);
    for (const deal of report.deals) {
      expect(deal.withinTolerance, `deal ${deal.dealId} outside tolerance (diffTicks=${String(deal.diffTicks)})`).toBe(
        true,
      );
    }
    expect(report.matchedCount).toBe(35);
  });
});

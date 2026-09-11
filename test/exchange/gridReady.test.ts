import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { makeGridExchangeReady } from '../../src/exchange/gridReady.js';
import { projectGrid } from '../../src/grid/projectGrid.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { defaultMarket as market } from '../helpers/fixtures.js';

describe('makeGridExchangeReady — basic shape', () => {
  it('rounds prices to tickSize and sizes to stepSize', () => {
    const config = buildConfig({
      deposit_usdt: 10_000,
      leverage: 5,
      grid: { orders: 3, overlap_pct: 10, indent_pct: 1, martingale_pct: 0, log_distribution: 1 },
    });
    const plan = projectGrid(config, 1901.5449, 'deal-1');

    const result = makeGridExchangeReady(plan, market);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    for (const rung of result.rungs) {
      // price must be an exact multiple of tickSize (within float noise)
      expect(Math.round(rung.price / market.tickSize)).toBeCloseTo(rung.price / market.tickSize, 6);
      expect(Math.round(rung.size / market.stepSize)).toBeCloseTo(rung.size / market.stepSize, 6);
    }
  });

  it('keeps clientOrderId and rung index from the original plan', () => {
    const config = buildConfig({
      deposit_usdt: 10_000,
      leverage: 5,
      grid: { orders: 2, overlap_pct: 10, indent_pct: 1 },
    });
    const plan = projectGrid(config, 1901.5449, 'deal-xyz');

    const result = makeGridExchangeReady(plan, market);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.rungs[0]?.clientOrderId).toBe('deal-xyz-1');
    expect(result.rungs[0]?.index).toBe(1);
    expect(result.rungs[1]?.clientOrderId).toBe('deal-xyz-2');
  });

  it('rejects the WHOLE grid when any rung falls below minNotional (MVP §13.3)', () => {
    // Tiny budget -> tiny per-rung notional, well under minNotional=5.
    const config = buildConfig({
      deposit_usdt: 1,
      leverage: 1,
      grid: { orders: 5, overlap_pct: 10, indent_pct: 1 },
    });
    const plan = projectGrid(config, 1901.5449, 'deal-tiny');

    const result = makeGridExchangeReady(plan, market);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toMatch(/minNotional/);
    expect(result.rungIndex).toBeGreaterThanOrEqual(1);
  });
});

describe('makeGridExchangeReady — Bybit-style minQty check (Slice C2b: minNotional=null, independent constraint)', () => {
  const bybitMarket = {
    symbol: 'ETH/USDT:USDT',
    tickSize: 0.01,
    stepSize: 0.001,
    minNotional: null,
    minQty: 0.01,
  };

  it('rejects the WHOLE grid when a rung size falls below minQty, even though minNotional is null and skipped entirely', () => {
    const plan = {
      entryPrice: 2000,
      rungs: [
        { index: 1, depthPct: 0, price: 2000, notionalUsdt: 2000 * 0.02, size: 0.02, clientOrderId: 'd-1' },
        { index: 2, depthPct: 0, price: 1900, notionalUsdt: 1900 * 0.005, size: 0.005, clientOrderId: 'd-2' },
      ],
    };

    const result = makeGridExchangeReady(plan, bybitMarket);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toMatch(/minQty/);
    expect(result.rungIndex).toBe(2);
  });

  it('accepts a grid whose every rung size clears minQty', () => {
    const plan = {
      entryPrice: 2000,
      rungs: [
        { index: 1, depthPct: 0, price: 2000, notionalUsdt: 2000 * 0.02, size: 0.02, clientOrderId: 'd-1' },
        { index: 2, depthPct: 0, price: 1900, notionalUsdt: 1900 * 0.015, size: 0.015, clientOrderId: 'd-2' },
      ],
    };

    const result = makeGridExchangeReady(plan, bybitMarket);

    expect(result.ok).toBe(true);
  });
});

function syntheticPlan(price: number, size: number) {
  return {
    entryPrice: price,
    rungs: [
      { index: 1, depthPct: 0, price, notionalUsdt: price * size, size, clientOrderId: 'x-1' },
    ],
  };
}

describe('makeGridExchangeReady — rounding correctness', () => {
  it.each([
    [1897.734, 0.01, 1897.73],
    [1897.736, 0.01, 1897.74],
  ])(
    'rounds price %d to the NEAREST multiple of tickSize %d -> %d (matches ccxt priceToPrecision/ROUND)',
    (price, tickSize, expected) => {
      const plan = syntheticPlan(price, 1);
      const result = makeGridExchangeReady(plan, {
        symbol: 'X',
        tickSize,
        stepSize: 1,
        minNotional: 0,
        minQty: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.rungs[0]?.price).toBeCloseTo(expected, 9);
    },
  );

  it.each([
    [0.018504, 0.001, 0.018],
    [0.018999, 0.001, 0.018],
    [0.019001, 0.001, 0.019],
  ])(
    'truncates size %d DOWN to a multiple of stepSize %d -> %d (matches ccxt amountToPrecision/TRUNCATE)',
    (size, stepSize, expected) => {
      const plan = syntheticPlan(1000, size); // large price so notional clears minNotional=0 trivially
      const result = makeGridExchangeReady(plan, {
        symbol: 'X',
        tickSize: 1,
        stepSize,
        minNotional: 0,
        minQty: null,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(result.rungs[0]?.size).toBeCloseTo(expected, 9);
    },
  );
});

describe('makeGridExchangeReady — Survivor pipeline regression (projectGrid -> gridReady)', () => {
  it('rounds the first three rung prices/sizes to the values actually observed for the calibrated Survivor point', () => {
    // Same anchor as Slice 2 (P_entry 1901.54, L 1.3) run through the full
    // pipeline against ETH's real tick/step, ties grid math + exchange
    // rounding back to one another instead of testing each in isolation.
    const config = buildConfig({
      deposit_usdt: 200,
      leverage: 3,
      grid: {
        overlap_pct: 35,
        orders: 14,
        martingale_pct: 3,
        indent_pct: 0.2,
        log_distribution: 1.3,
      },
    });
    const plan = projectGrid(config, 1901.54, 'deal-survivor');

    const result = makeGridExchangeReady(plan, market);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // Sprint 3 Task E: projectGrid's formula was fixed (two-stage from
    // rung 1, not one curve from anchor) — rungs 2/3 here changed
    // accordingly (1874.16->1874.07, 1839.67->1839.46), matching the real
    // live-order confirmation in CLAUDE.md/docs/MVP-done.md §4.1. Sizes
    // are unaffected (they depend on notionalUsdt, which didn't change).
    expect(result.rungs[0]?.price).toBeCloseTo(1897.74, 9);
    expect(result.rungs[1]?.price).toBeCloseTo(1874.07, 9);
    expect(result.rungs[2]?.price).toBeCloseTo(1839.46, 9);
    expect(result.rungs[0]?.size).toBeCloseTo(0.018, 9);
    expect(result.rungs[1]?.size).toBeCloseTo(0.019, 9);
    expect(result.rungs[2]?.size).toBeCloseTo(0.02, 9);
  });
});

const marketArb = fc.record({
  symbol: fc.constant('X/Y:Y'),
  tickSize: fc.constantFrom(0.01, 0.1, 1, 0.001),
  stepSize: fc.constantFrom(0.001, 0.01, 0.1, 1),
  minNotional: fc.constant(0), // isolate the rounding property from the minNotional rejection
  minQty: fc.constant(null),
});

describe('makeGridExchangeReady — property invariants', () => {
  it('every ok rung price/size is an exact multiple of tickSize/stepSize', () => {
    fc.assert(
      fc.property(
        marketArb,
        fc.array(fc.double({ min: 1, max: 100_000, noNaN: true }), { minLength: 1, maxLength: 10 }),
        (market_, prices) => {
          const rungs = prices.map((price, i) => ({
            index: i + 1,
            depthPct: 0,
            price,
            notionalUsdt: price * 10,
            size: price / 10,
            clientOrderId: `d-${String(i + 1)}`,
          }));
          const plan = { entryPrice: prices[0] ?? 0, rungs };

          const result = makeGridExchangeReady(plan, market_);
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error('expected ok result');

          for (const rung of result.rungs) {
            const priceSteps = rung.price / market_.tickSize;
            const sizeSteps = rung.size / market_.stepSize;
            expect(priceSteps).toBeCloseTo(Math.round(priceSteps), 6);
            expect(sizeSteps).toBeCloseTo(Math.round(sizeSteps), 6);
          }
        },
      ),
    );
  });
});

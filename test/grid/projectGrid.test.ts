import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { projectGrid } from '../../src/grid/projectGrid.js';
import { buildConfig } from '../helpers/buildConfig.js';

const SURVIVOR_ENTRY_PRICE = 1901.54;

describe('projectGrid — Survivor anchor point (MVP §4.1, calibrated on live orders)', () => {
  const plan = projectGrid(buildConfig(), SURVIVOR_ENTRY_PRICE, 'deal-1');

  it('produces exactly N rungs', () => {
    expect(plan.rungs).toHaveLength(14);
  });

  it('prices the first three rungs on the power-law curve (x=(i-1)/(N-1), depth=indent+(overlap-indent)*x^L)', () => {
    expect(plan.rungs[0]?.price).toBeCloseTo(1897.73692, 4);
    expect(plan.rungs[1]?.price).toBeCloseTo(1874.15613, 4);
    expect(plan.rungs[2]?.price).toBeCloseTo(1839.674204, 4);
  });

  it('prices the last rung exactly at overlap_pct depth', () => {
    expect(plan.rungs[13]?.depthPct).toBeCloseTo(35, 9);
    expect(plan.rungs[13]?.price).toBeCloseTo(1236.001, 3);
  });

  it('sizes the first three rungs by multiplicative martingale over the leveraged budget', () => {
    expect(plan.rungs[0]?.notionalUsdt).toBeCloseTo(35.115803, 4);
    expect(plan.rungs[1]?.notionalUsdt).toBeCloseTo(36.169277, 4);
    expect(plan.rungs[2]?.notionalUsdt).toBeCloseTo(37.254356, 4);
  });

  it('sums all rung notionals to deposit_usdt × leverage', () => {
    const total = plan.rungs.reduce((sum, rung) => sum + rung.notionalUsdt, 0);
    expect(total).toBeCloseTo(600, 6);
  });

  it('derives clientOrderId from dealId and 1-based rung index', () => {
    expect(plan.rungs[0]?.clientOrderId).toBe('deal-1-1');
    expect(plan.rungs[13]?.clientOrderId).toBe('deal-1-14');
  });
});

describe('projectGrid — basic shape', () => {
  it('sets the first rung depth to indent_pct exactly', () => {
    const plan = projectGrid(buildConfig(), SURVIVOR_ENTRY_PRICE, 'deal-1');
    expect(plan.rungs[0]?.depthPct).toBeCloseTo(0.2, 9);
  });

  it('handles the minimum grid size of 2 orders', () => {
    const config = buildConfig({ grid: { orders: 2, overlap_pct: 10, indent_pct: 0 } });
    const plan = projectGrid(config, 100, 'deal-min');
    expect(plan.rungs).toHaveLength(2);
    expect(plan.rungs[0]?.depthPct).toBeCloseTo(0, 9);
    expect(plan.rungs[1]?.depthPct).toBeCloseTo(10, 9);
  });
});

const gridParamsArb = fc
  .record({
    indent_pct: fc.double({ min: 0, max: 5, noNaN: true }),
    overlapDelta: fc.double({ min: 0.5, max: 50, noNaN: true }),
    orders: fc.integer({ min: 2, max: 30 }),
    martingale_pct: fc.double({ min: 0, max: 20, noNaN: true }),
    log_distribution: fc.double({ min: 0.2, max: 4, noNaN: true }),
  })
  .map(({ indent_pct, overlapDelta, orders, martingale_pct, log_distribution }) => ({
    indent_pct,
    overlap_pct: indent_pct + overlapDelta,
    orders,
    martingale_pct,
    log_distribution,
    partial_placement: null,
    runaway_cancel_pct: 0,
  }));

const budgetArb = fc.record({
  deposit_usdt: fc.double({ min: 1, max: 100_000, noNaN: true }),
  leverage: fc.integer({ min: 1, max: 125 }),
});

const entryPriceArb = fc.double({ min: 1, max: 100_000, noNaN: true });

describe('projectGrid — property invariants (MVP §4, §8)', () => {
  it('sum of rung notionals equals deposit_usdt × leverage', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid });
        const plan = projectGrid(config, entryPrice, 'deal');
        const total = plan.rungs.reduce((sum, rung) => sum + rung.notionalUsdt, 0);
        const expectedBudget = budget.deposit_usdt * budget.leverage;
        const relativeError = Math.abs(total - expectedBudget) / expectedBudget;
        expect(relativeError).toBeLessThan(1e-9);
      }),
    );
  });

  it('prices are strictly decreasing for long', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid });
        const plan = projectGrid(config, entryPrice, 'deal');
        for (let i = 1; i < plan.rungs.length; i++) {
          expect(plan.rungs[i]?.price).toBeLessThan(plan.rungs[i - 1]?.price ?? Infinity);
        }
      }),
    );
  });

  it('rung 1 sits at indent_pct depth and rung N sits at overlap_pct depth', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid });
        const plan = projectGrid(config, entryPrice, 'deal');
        expect(plan.rungs[0]?.depthPct).toBeCloseTo(grid.indent_pct, 6);
        expect(plan.rungs[plan.rungs.length - 1]?.depthPct).toBeCloseTo(grid.overlap_pct, 6);
      }),
    );
  });

  it('L=1 produces equal depth steps between consecutive rungs (linear)', () => {
    fc.assert(
      fc.property(
        gridParamsArb.map((grid) => ({ ...grid, log_distribution: 1 })),
        budgetArb,
        entryPriceArb,
        (grid, budget, entryPrice) => {
          const config = buildConfig({ ...budget, grid });
          const plan = projectGrid(config, entryPrice, 'deal');
          const steps = plan.rungs
            .slice(1)
            .map((rung, i) => rung.depthPct - (plan.rungs[i]?.depthPct ?? 0));
          for (const step of steps) {
            expect(step).toBeCloseTo(steps[0] ?? 0, 6);
          }
        },
      ),
    );
  });

  it('L>1 makes depth steps grow deeper (each step larger than the previous)', () => {
    fc.assert(
      fc.property(
        gridParamsArb
          .filter((grid) => grid.orders >= 3)
          .map((grid) => ({ ...grid, log_distribution: 1 + Math.abs(grid.log_distribution) })),
        budgetArb,
        entryPriceArb,
        (grid, budget, entryPrice) => {
          const config = buildConfig({ ...budget, grid });
          const plan = projectGrid(config, entryPrice, 'deal');
          const steps = plan.rungs
            .slice(1)
            .map((rung, i) => rung.depthPct - (plan.rungs[i]?.depthPct ?? 0));
          for (let i = 1; i < steps.length; i++) {
            expect(steps[i]).toBeGreaterThan(steps[i - 1] ?? -Infinity);
          }
        },
      ),
    );
  });
});

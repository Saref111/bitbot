import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { projectGrid } from '../../src/grid/projectGrid.js';
import { buildConfig } from '../helpers/buildConfig.js';

const SURVIVOR_ENTRY_PRICE = 1901.54;

describe('projectGrid — exchange-agnostic (Sprint 4 Task C, Slice C5)', () => {
  it('config.exchange never affects the output — projectGrid does not read it at all', () => {
    const binancePlan = projectGrid(
      buildConfig({ exchange: 'binance-futures' }),
      SURVIVOR_ENTRY_PRICE,
      'deal-1',
    );
    const bybitPlan = projectGrid(
      buildConfig({ exchange: 'bybit-futures' }),
      SURVIVOR_ENTRY_PRICE,
      'deal-1',
    );

    expect(bybitPlan).toEqual(binancePlan);
  });
});

describe('projectGrid — Survivor anchor point (MVP §4.1, calibrated on live orders)', () => {
  const plan = projectGrid(buildConfig(), SURVIVOR_ENTRY_PRICE, 'deal-1');

  it('produces exactly N rungs', () => {
    expect(plan.rungs).toHaveLength(14);
  });

  it('prices the first three rungs on the TWO-STAGE power-law curve (rung 1 from anchor via indent_pct; rungs 2+ from rung 1 via full overlap_pct*x^L)', () => {
    // Sprint 3 Task E: the single-stage "depth=indent+(overlap-indent)*x^L
    // from anchor" formula previously asserted here (1874.15613,
    // 1839.674204) was CONFIRMED WRONG against real live-order data
    // already recorded in CLAUDE.md ("P_entry 1901.54, L 1.3 -> 1897.74 /
    // 1874.07 / 1839.46") and independently reconfirmed via a real ExampleExchange
    // preview screenshot (all 13 visible rungs match the two-stage model
    // to ~0.01 USDT, the anchor-model's residual grows to ~2.93 USDT by
    // rung 13). See docs/MVP-done.md §4.1 for the full derivation.
    expect(plan.rungs[0]?.price).toBeCloseTo(1897.73692, 4);
    expect(plan.rungs[1]?.price).toBeCloseTo(1874.0680408, 6);
    expect(plan.rungs[2]?.price).toBeCloseTo(1839.4573032, 6);
  });

  it('prices the last rung at overlap_pct depth FROM RUNG 1 (not from anchor)', () => {
    // Depth-from-anchor at rung N is indent+overlap-indent*overlap/100
    // (35.13 for indent=0.2/overlap=35), NOT the bare overlap_pct — that
    // would only be true if depth were measured from anchor, which it
    // isn't for i>=2. See docs/MVP-done.md §4.1.
    const rung1Price = plan.rungs[0]?.price ?? NaN;
    const rungNPrice = plan.rungs[13]?.price ?? NaN;
    const depthFromRung1 = (1 - rungNPrice / rung1Price) * 100;
    expect(depthFromRung1).toBeCloseTo(35, 9);
    expect(rungNPrice).toBeCloseTo(1233.528998, 6);
    expect(plan.rungs[13]?.depthPct).toBeCloseTo(35.13, 9);
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

// Sprint 3 Task E, AC #4: these are spec-conformance checks (the formula
// matches its own written spec for arbitrary configs, at grid depths
// `orders` up to 30) — NOT ExampleExchange-fidelity checks. No real screenshot or
// Telegram fill data validates rungs deeper than k=4 (the deepest real
// fill in the fixture, deal 1175749436). Fidelity at the depths we DO
// have real data for is covered by gridFidelityCheck.test.ts (screenshot)
// and dealRungReconstruction.test.ts (real fills) instead.
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

  it('rung 1 sits at indent_pct depth from anchor; rung N sits at overlap_pct depth FROM RUNG 1', () => {
    // Sprint 3 Task E: depth-from-ANCHOR at rung N is NOT overlap_pct —
    // that was the bug. It's overlap_pct measured from rung 1's own
    // price (the two-stage formula's actual invariant).
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid });
        const plan = projectGrid(config, entryPrice, 'deal');
        expect(plan.rungs[0]?.depthPct).toBeCloseTo(grid.indent_pct, 6);

        const rung1Price = plan.rungs[0]?.price ?? NaN;
        const rungNPrice = plan.rungs[plan.rungs.length - 1]?.price ?? NaN;
        const depthFromRung1 = (1 - rungNPrice / rung1Price) * 100;
        expect(depthFromRung1).toBeCloseTo(grid.overlap_pct, 6);
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

  it('each rung notional is the previous times (1 + martingale_pct/100)', () => {
    // Sprint 3 Task E, AC #4: the pre-existing "sum of notionals = budget"
    // test only proves the AGGREGATE is right — a formula with the wrong
    // per-rung ratio, compensated via v1, could in principle still pass
    // it. This asserts the martingale multiplier directly, per-rung.
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid });
        const plan = projectGrid(config, entryPrice, 'deal');
        const expectedRatio = 1 + grid.martingale_pct / 100;
        for (let i = 1; i < plan.rungs.length; i++) {
          const prevNotional = plan.rungs[i - 1]?.notionalUsdt ?? NaN;
          const notional = plan.rungs[i]?.notionalUsdt ?? NaN;
          expect(notional / prevNotional).toBeCloseTo(expectedRatio, 9);
        }
      }),
    );
  });
});

// Sprint 4 Task B: locks in the sign-flip mirror convention for SHORT
// (docs/SPRINT_4.md's "Конвенція дзеркала" decision) with an INDEPENDENT
// oracle, not projectGrid's own sideSign code re-read a different way —
// `2a - price^LONG` is explicitly rejected by the AC because code and test
// would then be wrong in the same way together (vacuous pass on a buggy
// grid). The in-test formula below still shares projectGrid's STRUCTURE
// (same x, same two-stage composition) — it only independently re-derives
// the sign, so on its own it would only catch a wrong sideSign mapping, not
// a structural bug (wrong x, swapped stages, additive vs multiplicative).
// Non-vacuity for the shared structure is borrowed transitively from the
// LONG exact-number tests above (pinned to real Survivor live-order data,
// 1897.73692/1233.528998) — that chain holds as long as those stay
// untouched. The two hand-computed anchors just below give SHORT its own
// external anchor for the boundary rungs, independent of any formula
// written in this file, closing that borrowed link at exactly the two
// points where it matters most (rung 1 and rung N).
describe('projectGrid — SHORT mirror (Sprint 4 Task B)', () => {
  it('SHORT rung 1 and rung N match hand-computed Survivor anchors (not derived from the in-test formula below)', () => {
    // entry=1901.54, indent_pct=0.2, overlap_pct=35 (Survivor defaults).
    // rung 1  = 1901.54 * 1.002 = 1905.34308 (mirrors LONG's 1901.54*0.998=1897.73692)
    // rung 14 = 1905.34308 * 1.35 = 2572.213158 (x=1 at the last rung, so x^L=1
    //   regardless of L — mirrors LONG's 1897.73692*0.65=1233.528998)
    const config = buildConfig({ direction: 'short' });
    const plan = projectGrid(config, SURVIVOR_ENTRY_PRICE, 'deal-1');
    expect(plan.rungs[0]?.price).toBeCloseTo(1905.34308, 4);
    expect(plan.rungs[13]?.price).toBeCloseTo(2572.213158, 6);
  });

  it('SHORT prices match the independent sign-flip oracle anchor*(1+indent/100)*(1+overlap*x^L/100)', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid, direction: 'short' });
        const plan = projectGrid(config, entryPrice, 'deal');
        for (let i = 1; i <= plan.rungs.length; i++) {
          const x = (i - 1) / (plan.rungs.length - 1);
          const expected =
            entryPrice *
            (1 + grid.indent_pct / 100) *
            (1 + (grid.overlap_pct * Math.pow(x, grid.log_distribution)) / 100);
          expect(plan.rungs[i - 1]?.price).toBeCloseTo(expected, 6);
        }
      }),
    );
  });

  it('notional is exactly equal between LONG and SHORT for every rung (side-invariant by construction)', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const longPlan = projectGrid(
          buildConfig({ ...budget, grid, direction: 'long' }),
          entryPrice,
          'deal',
        );
        const shortPlan = projectGrid(
          buildConfig({ ...budget, grid, direction: 'short' }),
          entryPrice,
          'deal',
        );
        for (let i = 0; i < longPlan.rungs.length; i++) {
          // Exact equality, not toBeCloseTo — a tolerant check would miss
          // side accidentally leaking into the weight/budget computation.
          expect(shortPlan.rungs[i]?.notionalUsdt).toBe(longPlan.rungs[i]?.notionalUsdt);
        }
      }),
    );
  });

  it('SHORT size is the derived ratio notionalUsdt / price for every rung', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid, direction: 'short' });
        const plan = projectGrid(config, entryPrice, 'deal');
        for (const rung of plan.rungs) {
          expect(rung.size).toBeCloseTo(rung.notionalUsdt / rung.price, 9);
        }
      }),
    );
  });

  it('SHORT: sum of rung notionals equals deposit_usdt × leverage (distribution check, MVP §8)', () => {
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const config = buildConfig({ ...budget, grid, direction: 'short' });
        const plan = projectGrid(config, entryPrice, 'deal');
        const total = plan.rungs.reduce((sum, rung) => sum + rung.notionalUsdt, 0);
        const expectedBudget = budget.deposit_usdt * budget.leverage;
        const relativeError = Math.abs(total - expectedBudget) / expectedBudget;
        expect(relativeError).toBeLessThan(1e-9);
      }),
    );
  });

  it('sumWeights/v1 are side-invariant (direct assert against an independently-computed v1, not just LONG vs SHORT equality)', () => {
    // AC rationale: comparing LONG's and SHORT's OUTPUT notionals to each
    // other (the test above) would miss a bug where side leaks into the
    // budget math but does so IDENTICALLY for both sides — this anchors
    // rung 1's notional (= v1, since weight_1 = (1+m)^0 = 1) against v1
    // computed independently here from the same budget/weights formula.
    fc.assert(
      fc.property(gridParamsArb, budgetArb, entryPriceArb, (grid, budget, entryPrice) => {
        const weights: number[] = [];
        for (let i = 1; i <= grid.orders; i++) {
          weights.push(Math.pow(1 + grid.martingale_pct / 100, i - 1));
        }
        const sumWeights = weights.reduce((sum, w) => sum + w, 0);
        const v1 = (budget.deposit_usdt * budget.leverage) / sumWeights;

        const longPlan = projectGrid(
          buildConfig({ ...budget, grid, direction: 'long' }),
          entryPrice,
          'deal',
        );
        const shortPlan = projectGrid(
          buildConfig({ ...budget, grid, direction: 'short' }),
          entryPrice,
          'deal',
        );
        expect(longPlan.rungs[0]?.notionalUsdt).toBeCloseTo(v1, 6);
        expect(shortPlan.rungs[0]?.notionalUsdt).toBeCloseTo(v1, 6);
      }),
    );
  });
});

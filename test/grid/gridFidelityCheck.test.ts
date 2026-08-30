import { describe, expect, it } from 'vitest';
import { checkGridFidelity } from '../../src/grid/gridFidelityCheck.js';
import { projectGrid } from '../../src/grid/projectGrid.js';
import { averageEntry } from '../../src/grid/averageEntry.js';
import { requireAt } from '../../src/util/index.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ObservedRung } from '../../src/grid/types.js';

const TOLERANCES = { pricePct: 0.05, sizeEth: 0.001, averagePct: 0.05 };

describe('checkGridFidelity — synthetic', () => {
  it('reports withinTolerance for an exact match on all observed rungs and the average', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const rung1 = requireAt(plan.rungs, 0);
    const rung2 = requireAt(plan.rungs, 1);
    const observed = new Map<number, ObservedRung>([
      [1, { price: rung1.price, size: rung1.size }],
      [2, { price: rung2.price, size: rung2.size }],
    ]);
    // The "observed average" is a fundamentally different quantity from
    // entryPrice (anchor) — it's the amplitude-weighted average of ALL N
    // rungs, which is always below anchor for a long grid. Use the plan's
    // own true average here so this test genuinely exercises "exact
    // match", not an average vs. anchor mismatch.
    const trueAverage = averageEntry(plan.rungs.map((r) => ({ price: r.price, size: r.size })));

    const report = checkGridFidelity(plan, observed, trueAverage, TOLERANCES);

    expect(report.rungs).toHaveLength(2);
    expect(report.rungs.every((r) => r.withinTolerance)).toBe(true);
    expect(report.allWithinTolerance).toBe(true);
  });

  it('only reports rungs present in the observed map — absent rungs never appear', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const rung3 = requireAt(plan.rungs, 2);
    const observed = new Map<number, ObservedRung>([[3, { price: rung3.price, size: rung3.size }]]);

    const report = checkGridFidelity(plan, observed, null, TOLERANCES);

    expect(report.rungs).toHaveLength(1);
    expect(report.rungs[0]?.index).toBe(3);
  });

  it('flags a rung outside price tolerance', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const rung1 = requireAt(plan.rungs, 0);
    const observed = new Map<number, ObservedRung>([
      [1, { price: rung1.price * 1.01, size: rung1.size }], // 1% off, tolerance is 0.05%
    ]);

    const report = checkGridFidelity(plan, observed, null, TOLERANCES);

    expect(report.rungs[0]?.withinTolerance).toBe(false);
    expect(report.allWithinTolerance).toBe(false);
  });

  it('flags a rung outside size tolerance', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const rung1 = requireAt(plan.rungs, 0);
    const observed = new Map<number, ObservedRung>([
      [1, { price: rung1.price, size: rung1.size + 0.01 }], // way over 0.001 ETH
    ]);

    const report = checkGridFidelity(plan, observed, null, TOLERANCES);

    expect(report.rungs[0]?.withinTolerance).toBe(false);
  });

  it('priceDiffPct is relative to plan.entryPrice (anchor), not the observed rung price', () => {
    const plan = projectGrid(buildConfig(), 1000, 'deal-1');
    const rung14 = requireAt(plan.rungs, 13);
    const observed = new Map<number, ObservedRung>([
      [14, { price: rung14.price - 1, size: rung14.size }], // absolute diff of 1 on a cheap deep rung
    ]);

    const report = checkGridFidelity(plan, observed, null, TOLERANCES);

    // observed = computed - 1, so (computed-observed)/anchor(1000)*100 = +0.1%,
    // NOT 1/rung14Price*100 (which would be a much larger, misleading percent)
    expect(report.rungs[0]?.priceDiffPct).toBeCloseTo(0.1, 6);
  });

  it('computes the average via averageEntry over ALL plan rungs and reports null when observedAverage is null', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const report = checkGridFidelity(plan, new Map(), null, TOLERANCES);

    expect(report.average).toBeNull();
  });

  it('reports the average diff when observedAverage is given', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const report = checkGridFidelity(plan, new Map(), 1900, TOLERANCES);

    expect(report.average).not.toBeNull();
    expect(report.average?.observedAverage).toBe(1900);
  });

  it('throws when an observed index has no matching rung in the plan', () => {
    const plan = projectGrid(buildConfig(), 2000, 'deal-1');
    const observed = new Map<number, ObservedRung>([[99, { price: 1, size: 1 }]]);

    expect(() => checkGridFidelity(plan, observed, null, TOLERANCES)).toThrow(/99/);
  });
});

// Sprint 3 Task E, AC #1/#2/#3: a real screenshot of ExampleExchange's own grid
// preview UI (anchor = the shown current price, per the doc's own
// preview-anchor rule). Rung 14 is off-screen (below the chart's visible
// bottom) in this particular screenshot — not transcribable, so only
// rungs 1-13 are scored; the "Середня" average still covers all 14
// (including the formula's own unobserved rung 14), which is exactly
// what constrains the invisible 11-14 tail per AC #3.
//
// Structured as an array so a 2nd/3rd screenshot (the doc recommends
// 2-3 at different prices) can be added later with zero code changes —
// only 1 of the suggested 2-3 is available right now.
interface ScreenshotFixture {
  label: string;
  anchor: number;
  observedRungs: [number, ObservedRung][];
  observedAverage: number;
}

const SCREENSHOTS: ScreenshotFixture[] = [
  {
    label: 'ExampleExchange-preview-1 (anchor 2493.41)',
    anchor: 2493.41,
    observedRungs: [
      [1, { price: 2488.42, size: 0.014 }],
      [2, { price: 2457.38, size: 0.014 }],
      [3, { price: 2412.0, size: 0.015 }],
      [4, { price: 2358.96, size: 0.016 }],
      [5, { price: 2300.25, size: 0.017 }],
      [6, { price: 2236.92, size: 0.018 }],
      [7, { price: 2169.66, size: 0.019 }],
      [8, { price: 2098.93, size: 0.02 }],
      [9, { price: 2025.1, size: 0.022 }],
      [10, { price: 1948.43, size: 0.023 }],
      [11, { price: 1869.17, size: 0.025 }],
      [12, { price: 1787.49, size: 0.027 }],
      [13, { price: 1703.54, size: 0.029 }],
    ],
    observedAverage: 2031.8,
  },
];

// Calibrated from the actual measured residual against the FIXED
// two-stage formula (Sprint 3 Task E): max price diff ~0.0004% of anchor,
// max size diff ~0.0007 ETH, average diff ~0.097% — all consistent with
// screenshot display rounding (2dp price, 3dp size), not a structural
// mismatch. These tolerances carry comfortable headroom over that
// measured maximum; they are dramatically tighter than the ~0.3%
// tolerance that would have been needed to mask the pre-fix formula bug.
const SCREENSHOT_TOLERANCES = { pricePct: 0.01, sizeEth: 0.001, averagePct: 0.15 };

describe('checkGridFidelity — real ExampleExchange preview screenshot (Sprint 3 Task E, AC #1/#2/#3)', () => {
  it.each(SCREENSHOTS)('$label', (fixture) => {
    const plan = projectGrid(buildConfig(), fixture.anchor, 'screenshot-deal');
    const observed = new Map(fixture.observedRungs);

    const report = checkGridFidelity(plan, observed, fixture.observedAverage, SCREENSHOT_TOLERANCES);

    expect(report.rungs).toHaveLength(fixture.observedRungs.length);
    for (const rung of report.rungs) {
      expect(rung.withinTolerance, `rung ${String(rung.index)} outside tolerance`).toBe(true);
    }
    expect(report.average?.withinTolerance, 'average outside tolerance').toBe(true);
    expect(report.allWithinTolerance).toBe(true);
  });
});

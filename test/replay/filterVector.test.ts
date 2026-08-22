import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { computeFilterVector } from '../../src/replay/filterVector.js';
import { compareToGoldenVector, checkMultiplicity } from '../../src/replay/goldenVectorCheck.js';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { requireAt } from '../../src/util/index.js';
import type { ReplayBarResult } from '../../src/replay/types.js';
import type { EntryFilter } from '../../src/config/types.js';
import type { Candle } from '../../src/candles/types.js';
import type { FilterSignal } from '../../src/filters/types.js';
import type { EntrySignal } from '../../src/feed/types.js';

const ONE_MINUTE_MS = 60_000;

function candle(index: number): Candle {
  const openTime = index * ONE_MINUTE_MS;
  return { openTime, closeTime: openTime + ONE_MINUTE_MS, open: 1, high: 1, low: 1, close: 1 };
}

function bar(
  index: number,
  filterStates: (FilterSignal | null)[],
  entrySignal: EntrySignal | null = null,
): ReplayBarResult {
  return {
    candle: candle(index),
    entrySignal,
    gridPlan: null,
    filterStates,
    filterValues: filterStates.map((s) => (s ? 1 : null)),
  };
}

describe('computeFilterVector — Sprint 3 Task C', () => {
  it('counts a 1m channel on every bar (modulus is always 0)', () => {
    const filters: EntryFilter[] = [{ indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 50 }];
    const active: FilterSignal = { active: true, since: 0 };
    const bars = [bar(0, [active]), bar(1, [active]), bar(2, [active])];

    const vector = computeFilterVector(filters, bars);

    expect(vector.channels[0]).toMatchObject({ activeBars: 3, totalBars: 3 });
  });

  it('counts a 5m channel only on bars whose closeTime lands on the 5m boundary — not every 1m latch-bar', () => {
    const filters: EntryFilter[] = [{ indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 50 }];
    const active: FilterSignal = { active: true, since: 0 };
    // 10 one-minute bars -> exactly 2 five-minute boundaries (indices 4, 9).
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, [active]));

    const vector = computeFilterVector(filters, bars);

    // The critical regression this guards: counting at 1m cadence would
    // give activeBars=10 here (latch held active the whole time), not 2 —
    // exactly the ~60x-for-1h-channel bug found against the real golden
    // vector during Sprint 3 Task C's design review.
    expect(vector.channels[0]).toMatchObject({ activeBars: 2, totalBars: 2 });
  });

  it('does not count a 5m channel bar when the latch is inactive at that boundary', () => {
    const filters: EntryFilter[] = [{ indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 50 }];
    const inactive: FilterSignal = { active: false, since: 0 };
    const active: FilterSignal = { active: true, since: 0 };
    // Boundary at index 4 inactive, boundary at index 9 active.
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, [i < 5 ? inactive : active]));

    const vector = computeFilterVector(filters, bars);

    expect(vector.channels[0]).toMatchObject({ activeBars: 1, totalBars: 2 });
  });

  it('treats a null filterState (not yet warmed up) as inactive, not a throw', () => {
    const filters: EntryFilter[] = [{ indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 50 }];
    const bars = [bar(0, [null]), bar(1, [null])];

    const vector = computeFilterVector(filters, bars);

    expect(vector.channels[0]).toMatchObject({ activeBars: 0, totalBars: 2 });
  });

  it('preserves entry_filters order and per-filter config fields in the output', () => {
    const filters: EntryFilter[] = [
      { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 },
      { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 70 },
    ];
    const bars = [bar(0, [null, null])];

    const vector = computeFilterVector(filters, bars);

    expect(vector.channels.map((c) => `${c.indicator} ${c.timeframe} ${String(c.value)}`)).toEqual([
      'RSI 1h 55',
      'CCI 5m 70',
    ]);
  });

  it('andBars reuses entrySignal, andTotalBars is the full 1m bar count', () => {
    const filters: EntryFilter[] = [];
    const signal: EntrySignal = { price: 100, closeTime: 60_000 };
    const bars = [bar(0, [], signal), bar(1, [], null), bar(2, [], signal)];

    const vector = computeFilterVector(filters, bars);

    expect(vector.andBars).toBe(2);
    expect(vector.totalBars).toBe(3);
  });

  it('sanity: a 1h channel active for one full hour counts as exactly 1 bar, not 60', () => {
    const filters: EntryFilter[] = [{ indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 }];
    const active: FilterSignal = { active: true, since: 0 };
    const bars = Array.from({ length: 60 }, (_, i) => bar(i, [active]));

    const vector = computeFilterVector(filters, bars);

    expect(vector.channels[0]).toMatchObject({ activeBars: 1, totalBars: 1 });
  });
});

// MVP-done.md:132-139, "Приклад-дефолт: бот Survivor" — the confirmed real
// Survivor filter config, in the SAME order as the golden vector's own
// declared bracket order (docs/SPRINT 3.md §2). Order here is load-bearing:
// computeFilterVector mirrors entry_filters order verbatim, no reordering.
const SURVIVOR_FILTERS: EntryFilter[] = [
  { indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '30m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 },
  { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 70 },
  { indicator: 'CCI', timeframe: '15m', period: 20, op: '<', value: 75 },
  { indicator: 'CCI', timeframe: '1h', period: 20, op: '<', value: 80 },
];

// docs/SPRINT 3.md §2 — "Кількість сигналів за останній місяць" from the
// real Veles UI, rolling 30 days, re-captured 2026-08-22/23 to match the
// freshest window our downloaded fixtures cover (test/fixtures/binance-data
// only has daily dumps through 2026-08-21 — today's day is never published,
// per script.sh's own "до вчора" logic). Supersedes an earlier capture
// (~2026-08-19) that was compared against a slightly mismatched window and
// produced a since-resolved false RSI(30m) miss.
const GOLDEN_VECTOR = [21164, 4083, 620, 454, 5990, 2032, 497, 7744];

// Tolerance is in ABSOLUTE PERCENTAGE POINTS, not relative percent (see
// goldenVectorCheck.ts's diffChannel doc comment). Confirmed against the
// real fresh vector above: all 7 individual channels land within 0.2-1.3pp;
// 2pp gives comfortable headroom above the largest observed real deviation
// without being vacuously loose.
const GOLDEN_TOLERANCE_PP = 2;

describe('computeFilterVector + compareToGoldenVector — Sprint 3 Task C, real fixture data (AC #1/#2/#3)', () => {
  it('replays the real 30-day window (2026-07-23 -> 2026-08-22 UTC) and matches the golden vector within 2 percentage points per channel', () => {
    const config = buildConfig({ entry_filters: SURVIVOR_FILTERS });
    const csvDir = join(import.meta.dirname, '../fixtures/binance-data/csv');

    const result = replayWindow({
      config,
      csvDir,
      symbol: 'ETHUSDT',
      fromMs: Date.UTC(2026, 6, 23, 0, 0, 0),
      toMs: Date.UTC(2026, 7, 22, 0, 0, 0),
    });

    expect(result.bars).toHaveLength(30 * 24 * 60); // exactly 43200 — the golden vector's own implied denominator

    const vector = computeFilterVector(SURVIVOR_FILTERS, result.bars);
    const report = compareToGoldenVector(vector, GOLDEN_VECTOR, GOLDEN_TOLERANCE_PP);

    // AC #5: any failure localizes to its own channel, not a single boolean.
    const offenders = report.channels.filter((c) => !c.withinTolerance);
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
    // AND (the intersection of all 7 channels) previously looked like an
    // outlier under a RELATIVE-percent metric (~3.9%) purely because its
    // golden baseline (~18%) is much smaller than any single channel's
    // (~45-70%) — the same absolute shift reads as a much bigger relative
    // number on a smaller base. In absolute percentage points (the actual
    // metric used here) it is ~0.7pp, on par with the RSI/CCI 1h channels'
    // own shifts, and passes the same GOLDEN_TOLERANCE_PP as every other
    // channel — no special-casing needed once the metric itself is correct
    // (Task C review, 2026-08-23).
    expect(report.and.withinTolerance, JSON.stringify(report.and, null, 2)).toBe(true);
    expect(report.allWithinTolerance).toBe(true);

    // AC #3: RSI(1m) lands near 50% of its own (1m) denominator — the
    // golden-vector check above already covers this numerically; this is
    // a read-only assertion of WHY (threshold 50 + Wilder), not new logic.
    const rsi1m = requireAt(vector.channels, 0);
    expect(rsi1m.activeBars / rsi1m.totalBars).toBeCloseTo(0.5, 1);

    // AC #2: channel multiplicity.
    const cci5m = requireAt(vector.channels, 4);
    const cci15m = requireAt(vector.channels, 5);
    const cci1h = requireAt(vector.channels, 6);
    const multiplicity5m15m = checkMultiplicity(cci5m, cci15m, 3, 0.1);
    const multiplicity5m1h = checkMultiplicity(cci5m, cci1h, 12, 0.1);
    expect(multiplicity5m15m.withinTolerance, JSON.stringify(multiplicity5m15m)).toBe(true);
    expect(multiplicity5m1h.withinTolerance, JSON.stringify(multiplicity5m1h)).toBe(true);
  }, 180_000);
});

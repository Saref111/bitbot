import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildFilterDump } from '../../src/replay/filterDump.js';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ReplayBarResult } from '../../src/replay/types.js';
import type { Candle } from '../../src/candles/types.js';
import type { FilterSignal } from '../../src/filters/types.js';
import type { EntryFilter } from '../../src/config/types.js';

const ONE_MINUTE_MS = 60_000;

function candle(index: number): Candle {
  const openTime = index * ONE_MINUTE_MS;
  return { openTime, closeTime: openTime + ONE_MINUTE_MS, open: 1, high: 1, low: 1, close: 1 };
}

function bar(index: number, state: FilterSignal | null, value: number | null): ReplayBarResult {
  return {
    candle: candle(index),
    entrySignal: null,
    gridPlan: null,
    filterStates: [state],
    filterValues: [value],
  };
}

describe('buildFilterDump — Sprint 3 Task C, AC #4', () => {
  it('emits one row per distinct since value, not one per 1m bar', () => {
    const s1: FilterSignal = { active: true, since: 300_000 };
    const s2: FilterSignal = { active: false, since: 600_000 };
    const bars = [
      bar(0, s1, 10),
      bar(1, s1, 10),
      bar(2, s1, 10),
      bar(3, s2, 20),
      bar(4, s2, 20),
    ];

    const rows = buildFilterDump(bars, 0);

    expect(rows).toEqual([
      { sinceCloseTime: 300_000, value: 10, active: true },
      { sinceCloseTime: 600_000, value: 20, active: false },
    ]);
  });

  it('re-emits a row if the same since value recurs non-consecutively (does not globally dedupe)', () => {
    const s1: FilterSignal = { active: true, since: 300_000 };
    const s2: FilterSignal = { active: false, since: 600_000 };
    const bars = [bar(0, s1, 10), bar(1, s2, 20), bar(2, s1, 10)];

    const rows = buildFilterDump(bars, 0);

    expect(rows).toHaveLength(3);
  });

  it('falls back to the bar\'s own closeTime for a still-warming-up (null) filter state', () => {
    const bars = [bar(0, null, null), bar(1, null, null)];

    const rows = buildFilterDump(bars, 0);

    // null state never changes across these bars -> collapses to one row,
    // using the FIRST bar's closeTime as the fallback marker.
    expect(rows).toEqual([{ sinceCloseTime: candle(0).closeTime, value: null, active: false }]);
  });

  it('transitions cleanly from a null (warming-up) state to a real one', () => {
    const s1: FilterSignal = { active: true, since: 600_000 };
    const bars = [bar(0, null, null), bar(1, null, null), bar(2, s1, 42)];

    const rows = buildFilterDump(bars, 0);

    expect(rows).toEqual([
      { sinceCloseTime: candle(0).closeTime, value: null, active: false },
      { sinceCloseTime: 600_000, value: 42, active: true },
    ]);
  });

  it('returns an empty array for an empty bar list', () => {
    expect(buildFilterDump([], 0)).toEqual([]);
  });
});

describe('buildFilterDump — Sprint 3 Task C, real fixture smoke test', () => {
  it('an RSI(1h) filter over one real day yields a sane row count close to 24', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 };
    const config = buildConfig({ entry_filters: [filter] });
    const csvDir = join(import.meta.dirname, '../fixtures/binance-data/csv');

    const result = replayWindow({
      config,
      csvDir,
      symbol: 'ETHUSDT',
      fromMs: Date.UTC(2026, 7, 1, 0, 0, 0),
      toMs: Date.UTC(2026, 7, 2, 0, 0, 0),
    });

    const rows = buildFilterDump(result.bars, 0);

    // 24 native 1h bars in a day; a small margin covers any edge effect at
    // the very start of the window before the first own-TF close lands.
    expect(rows.length).toBeGreaterThanOrEqual(23);
    expect(rows.length).toBeLessThanOrEqual(25);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { seedSignalEngine, ingestOneMinuteCandle } from '../../src/feed/signalEngine.js';
import { computeRsiSeries } from '../../src/indicators/rsi.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { TIMEFRAME_DURATION_MS } from '../../src/candles/index.js';
import type { Candle, Timeframe } from '../../src/candles/index.js';
import type { EntryFilter } from '../../src/config/types.js';
import type { Logger } from '../../src/logging/logger.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function hourCandle(index: number, close: number): Candle {
  const openTime = START + index * ONE_HOUR_MS;
  return { openTime, closeTime: openTime + ONE_HOUR_MS, open: close, high: close, low: close, close };
}

function oneMinute(index: number, close: number): Candle {
  const openTime = START + index * ONE_MINUTE_MS;
  return { openTime, closeTime: openTime + ONE_MINUTE_MS, open: close, high: close, low: close, close };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function tfCandle(timeframe: Timeframe, index: number, close: number): Candle {
  const durationMs = TIMEFRAME_DURATION_MS[timeframe];
  const openTime = START + index * durationMs;
  return { openTime, closeTime: openTime + durationMs, open: close, high: close, low: close, close };
}

// MVP §2 golden-vector filter set: RSI(14) on 1m/5m/30m/1h + CCI(20) on 5m/15m/1h.
const REAL_FILTER_SET: EntryFilter[] = [
  { indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 90 },
  { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 90 },
  { indicator: 'RSI', timeframe: '30m', period: 14, op: '<', value: 90 },
  { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 90 },
  { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 200 },
  { indicator: 'CCI', timeframe: '15m', period: 20, op: '<', value: 200 },
  { indicator: 'CCI', timeframe: '1h', period: 20, op: '<', value: 200 },
];

// Same deterministic drifting oscillation as the RSI warm-up-depth test in
// test/indicators/rsi.test.ts — mixed up/down, long enough that its own
// tail has converged past any seed-transient.
const FULL_SERIES = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.7) * 5 + i * 0.01);
const REFERENCE = computeRsiSeries(FULL_SERIES, 14).at(-1) as number;
const FULL_CANDLES = FULL_SERIES.map((close, i) => hourCandle(i, close));

describe('seedSignalEngine — replay-window warm-up depth (Sprint 3 Task A AC 1/2/3/7, integration level)', () => {
  const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 90 };
  const config = buildConfig({ entry_filters: [filter] });

  it('an insufficient native seed (30 bars) gives a first-bar value that diverges from reference', () => {
    const state = seedSignalEngine(config, { '1h': FULL_CANDLES.slice(-30) });

    expect(state.filterValues[0]).not.toBeNull();
    expect(Math.abs((state.filterValues[0] as number) - REFERENCE)).toBeGreaterThan(0.5);
  });

  it('a sufficient native seed (130 bars) matches the reference within rounding tolerance — AC: first bar of the replay window is non-null AND converged', () => {
    const state = seedSignalEngine(config, { '1h': FULL_CANDLES.slice(-130) });

    expect(state.filterValues[0]).toBeCloseTo(REFERENCE, 1);
  });

  it('all 7 filters (the real Survivor set: RSI 1m/5m/30m/1h + CCI 5m/15m/1h) are non-null on the first bar of the window when every tracked timeframe is sufficiently seeded — AC 1', () => {
    const config7 = buildConfig({ entry_filters: REAL_FILTER_SET });
    const seedFor = (tf: Timeframe): Candle[] =>
      FULL_SERIES.slice(-130).map((close, i) => tfCandle(tf, i, close));

    const state = seedSignalEngine(config7, {
      '1m': seedFor('1m'),
      '5m': seedFor('5m'),
      '15m': seedFor('15m'),
      '30m': seedFor('30m'),
      '1h': seedFor('1h'),
    });

    expect(state.filterValues).toHaveLength(7);
    for (const value of state.filterValues) {
      expect(value).not.toBeNull();
    }
  });
});

describe('seedSignalEngine — does not fire entry from the seed alone (Sprint 3 Task A design decision)', () => {
  const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 90 };
  const config = buildConfig({ entry_filters: [filter] });

  it('a seed that already satisfies every filter has no entrySignal to check — seedSignalEngine returns state only, by construction', () => {
    const state = seedSignalEngine(config, { '1h': FULL_CANDLES.slice(-130) });

    // Precondition for the next test: AND is already satisfied purely from
    // the seed (mirrors the pre-Task-A warm-up loop, which fed historical
    // bars into the engine but always discarded the resulting entrySignal).
    expect(state.filterStates[0]?.active).toBe(true);
  });

  it('entry fires on the very first LIVE tick once the seed already latched every filter active, even though that tick does not close the filter\'s own 1h timeframe', () => {
    const state = seedSignalEngine(config, { '1h': FULL_CANDLES.slice(-130) });
    expect(state.filterStates[0]?.active).toBe(true);

    const liveCandle: Candle = {
      openTime: 9_999_000_000,
      closeTime: 9_999_060_000,
      open: 1,
      high: 1,
      low: 1,
      close: 123,
    };
    // A single 1m tick can't complete a new 1h bucket on its own (needs 60)
    // — firing here proves the signal comes from the already-latched seed
    // state, not from a freshly-closed 1h bar.
    const result = ingestOneMinuteCandle(config, state, liveCandle);

    expect(result.entrySignal).toEqual({ price: 123, closeTime: liveCandle.closeTime });
  });
});

describe('seedSignalEngine — cold-start straddle: 1m seed feeds the still-open bucket of a non-1m tracked timeframe (bug fix)', () => {
  const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 1, op: '>', value: -1 };
  const config = buildConfig({ entry_filters: [filter] });

  it('closes the first post-seed 1h bucket using the straddling 1m seed, with no gap WARN and no lost bar', () => {
    // Native 1h seed: one prior complete hour (minute-index [0, 60)) — like
    // a cold start mid-hour with the previous hour already closed.
    const hourSeed = hourCandle(0, 100);
    // Native 1m seed straddling into the CURRENT, still-open hour: minutes
    // 60-96 (37 candles) — like starting warm-up at 14:37, with 14:00-14:36
    // already elapsed within the still-open [14:00,15:00) bucket.
    const oneMinuteSeed = Array.from({ length: 37 }, (_, i) => oneMinute(60 + i, 200));
    const logger = makeLogger();

    let state = seedSignalEngine(config, { '1h': [hourSeed], '1m': oneMinuteSeed }, logger);

    expect(logger.warn).not.toHaveBeenCalled(); // the seed fully covers the straddle already
    expect(state.candlesByTimeframe['1h']).toHaveLength(1); // only the seeded hour so far

    // Live ticks resume at minute 97 through 119 (23 ticks) — together with
    // the 37 seeded minutes above, that's exactly the 60 candles the
    // [14:00,15:00) bucket needs to close.
    for (let i = 97; i < 120; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinute(i, 250), logger).state;
    }

    expect(logger.warn).not.toHaveBeenCalled(); // no spurious gap+resync
    expect(state.candlesByTimeframe['1h']).toHaveLength(2); // the straddled bucket actually closed, not lost
  });

  it('warns when the 1m seed does not reach back far enough to cover the whole straddle', () => {
    const hourSeed = hourCandle(0, 100);
    // Only minutes 70-79 seeded (10 candles) — misses minutes 60-69 of the
    // still-open hour, an incomplete straddle.
    const shallowOneMinuteSeed = Array.from({ length: 10 }, (_, i) => oneMinute(70 + i, 200));
    const logger = makeLogger();

    seedSignalEngine(config, { '1h': [hourSeed], '1m': shallowOneMinuteSeed }, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ largestTrackedTimeframeMs: ONE_HOUR_MS }),
      expect.stringContaining('does not fully cover'),
    );
  });
});

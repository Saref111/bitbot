import { describe, expect, it, vi } from 'vitest';
import { createSignalEngine, ingestOneMinuteCandle } from '../../src/feed/signalEngine.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { Candle } from '../../src/candles/types.js';
import type { EntryFilter } from '../../src/config/types.js';
import type { Logger } from '../../src/logging/logger.js';

const ONE_MINUTE_MS = 60_000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function oneMinuteCandle(index: number, close: number): Candle {
  const openTime = START + index * ONE_MINUTE_MS;
  return {
    openTime,
    closeTime: openTime + ONE_MINUTE_MS,
    open: close + 0.5,
    high: close + 1,
    low: close - 1,
    close,
  };
}

/** Strictly decreasing closes -> RSI reads 0 on every timeframe once warmed (all down-moves, no ties). */
function decliningCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => oneMinuteCandle(i, 1000 - i));
}

function feed(config: ReturnType<typeof buildConfig>, candles: Candle[]) {
  let state = createSignalEngine(config);
  let firstEntryAtIndex: number | null = null;
  candles.forEach((candle, index) => {
    const result = ingestOneMinuteCandle(config, state, candle);
    state = result.state;
    if (result.entrySignal && firstEntryAtIndex === null) {
      firstEntryAtIndex = index;
    }
  });
  return { state, firstEntryAtIndex };
}

describe('signalEngine — empty filters (MVP §3: enter immediately)', () => {
  it('signals entry on the very first candle, regardless of price', () => {
    const config = buildConfig({ take_profit_pct: 1 });
    // buildConfig() defaults to entry_filters: [] already; keep explicit for clarity.
    expect(config.entry_filters).toEqual([]);

    let state = createSignalEngine(config);
    const result = ingestOneMinuteCandle(config, state, oneMinuteCandle(0, 12345));
    state = result.state;

    expect(result.entrySignal).toEqual({
      price: 12345,
      closeTime: oneMinuteCandle(0, 12345).closeTime,
    });
  });
});

describe('signalEngine — single filter (MVP §5: bar_close persistence)', () => {
  const filter5m: EntryFilter = {
    indicator: 'RSI',
    timeframe: '5m',
    period: 14,
    op: '<',
    value: 50,
  };

  it('signals entry exactly on the 1m candle that completes the 15th 5m bar (RSI warm-up), not before', () => {
    const config = buildConfig({ entry_filters: [filter5m] });
    const candles = decliningCandles(80);
    const { firstEntryAtIndex } = feed(config, candles);

    // 15 * 5 = 75 one-minute candles needed for the first non-null RSI(14) on 5m.
    expect(firstEntryAtIndex).toBe(74); // 0-based index of the 75th candle
  });

  it('never signals entry when the filter condition is never satisfied', () => {
    const impossible: EntryFilter = {
      indicator: 'RSI',
      timeframe: '5m',
      period: 14,
      op: '<',
      value: -1,
    };
    const config = buildConfig({ entry_filters: [impossible] });
    const candles = decliningCandles(80);
    const { firstEntryAtIndex } = feed(config, candles);

    expect(firstEntryAtIndex).toBeNull();
  });
});

describe('signalEngine — multiple filters across timeframes (MVP §5: full AND, checked higher->lower TF)', () => {
  it('waits for the SLOWEST filter to warm up even though a faster one is already active', () => {
    const filter5m: EntryFilter = {
      indicator: 'RSI',
      timeframe: '5m',
      period: 14,
      op: '<',
      value: 50,
    };
    const filter15m: EntryFilter = {
      indicator: 'RSI',
      timeframe: '15m',
      period: 14,
      op: '<',
      value: 50,
    };
    const config = buildConfig({ entry_filters: [filter5m, filter15m] });

    // 15 * 15 = 225 one-minute candles needed for the first non-null RSI(14) on 15m.
    const candles = decliningCandles(230);
    const { firstEntryAtIndex } = feed(config, candles);

    expect(firstEntryAtIndex).toBe(224); // 0-based index of the 225th candle
  });

  it('does not signal entry while only some filters are active', () => {
    const filter5m: EntryFilter = {
      indicator: 'RSI',
      timeframe: '5m',
      period: 14,
      op: '<',
      value: 50,
    };
    const neverSatisfied: EntryFilter = {
      indicator: 'RSI',
      timeframe: '15m',
      period: 14,
      op: '<',
      value: -1,
    };
    const config = buildConfig({ entry_filters: [filter5m, neverSatisfied] });

    const candles = decliningCandles(230);
    const { firstEntryAtIndex } = feed(config, candles);

    expect(firstEntryAtIndex).toBeNull();
  });
});

describe('signalEngine — DEBUG filter-state snapshot on bar_close (pino DEBUG only)', () => {
  function makeLogger(): Logger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  }

  it('does not log anything on a candle that closes no tracked timeframe bar', () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 90 };
    const config = buildConfig({ entry_filters: [filter5m] });
    const logger = makeLogger();
    let state = createSignalEngine(config);

    for (let i = 0; i < 4; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 100), logger).state;
    }
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('logs exactly one snapshot when the tracked bar closes, warm-up shown as value:null/pass:false (no throw)', () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 90 };
    const config = buildConfig({ entry_filters: [filter5m] });
    const logger = makeLogger();
    let state = createSignalEngine(config);

    for (let i = 0; i < 5; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 100), logger).state;
    }

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [snapshot, msg] = (logger.debug as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(snapshot).toMatchObject({
      triggeredTf: '5m',
      gatePassed: false,
      filters: [{ indicator: 'RSI', tf: '5m', value: null, threshold: 90, pass: false }],
      blockedBy: { indicator: 'RSI', tf: '5m', value: null, threshold: 90, pass: false },
    });
    expect(typeof snapshot.closeTimeMs).toBe('number');
    expect(snapshot.closeTimeIso).toBe(new Date(snapshot.closeTimeMs as number).toISOString());
    expect(typeof msg).toBe('string');
  });

  it('shows the FULL latched snapshot (every filter, not just the just-closed tf) on each of two simultaneous closes', () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 2, op: '<', value: 90 };
    const filter15m: EntryFilter = { indicator: 'RSI', timeframe: '15m', period: 2, op: '<', value: 90 };
    const config = buildConfig({ entry_filters: [filter5m, filter15m] });
    const logger = makeLogger();
    let state = createSignalEngine(config);
    const candles = decliningCandles(15);

    candles.forEach((candle) => {
      state = ingestOneMinuteCandle(config, state, candle, logger).state;
    });

    // Candle #15 closes the 3rd 5m bar (RSI(2) now warmed, non-null) AND the
    // 1st 15m bar (still null) at once — TIMEFRAME_ORDER processes 15m
    // before 5m, so the two DEBUG lines land in that order.
    const calls = (logger.debug as ReturnType<typeof vi.fn>).mock.calls as [
      Record<string, unknown>,
      string,
    ][];
    const lastTwo = calls.slice(-2);
    const [firstSnapshot] = lastTwo[0] as [Record<string, unknown>, string];
    const [secondSnapshot] = lastTwo[1] as [Record<string, unknown>, string];
    expect(firstSnapshot.triggeredTf).toBe('15m');
    expect(secondSnapshot.triggeredTf).toBe('5m');

    // At the 15m-triggered snapshot, the 5m filter still shows its
    // OLD (2-bar, still-null) latched value — 15m is processed first.
    const firstFilters = firstSnapshot.filters as { tf: string; value: number | null }[];
    expect(firstFilters.find((f) => f.tf === '5m')?.value).toBeNull();

    // The very next (5m-triggered) snapshot picks up the freshly-closed
    // 3rd 5m bar's non-null value — same tick, updated latch.
    const secondFilters = secondSnapshot.filters as { tf: string; value: number | null }[];
    expect(secondFilters.find((f) => f.tf === '5m')?.value).not.toBeNull();
    // ...while the 15m entry stays at what was JUST latched one step earlier.
    expect(secondFilters.find((f) => f.tf === '15m')?.value).toBeNull();
  });

  it('defaults to a silent logger when none is given (does not throw)', () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 90 };
    const config = buildConfig({ entry_filters: [filter5m] });
    let state = createSignalEngine(config);

    expect(() => {
      for (let i = 0; i < 5; i++) {
        state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 100)).state;
      }
    }).not.toThrow();
  });
});

describe('signalEngine — unsupported indicator', () => {
  it('throws rather than silently skipping an indicator it cannot compute, once its timeframe actually closes a bar', () => {
    const badFilter = {
      indicator: 'MACD',
      timeframe: '5m',
      period: 14,
      op: '<',
      value: 50,
    } as EntryFilter;
    const config = buildConfig({ entry_filters: [badFilter] });
    let state = createSignalEngine(config);

    // The first 4 candles don't complete a 5m bar yet, so nothing needs computing.
    for (let i = 0; i < 4; i++) {
      const result = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 100));
      state = result.state;
    }

    // The 5th candle completes the first 5m bar -> must compute MACD -> throws.
    expect(() => ingestOneMinuteCandle(config, state, oneMinuteCandle(4, 100))).toThrow(/MACD/);
  });
});

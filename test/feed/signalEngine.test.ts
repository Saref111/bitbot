import { describe, expect, it } from 'vitest';
import { createSignalEngine, ingestOneMinuteCandle } from '../../src/feed/signalEngine.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { Candle } from '../../src/candles/types.js';
import type { EntryFilter } from '../../src/config/types.js';

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

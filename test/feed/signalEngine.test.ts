import { describe, expect, it, vi } from 'vitest';
import { createSignalEngine, ingestOneMinuteCandle, seedSignalEngine } from '../../src/feed/signalEngine.js';
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

const FIVE_MINUTE_MS = 5 * ONE_MINUTE_MS;

function fiveMinuteCandle(index: number, close: number): Candle {
  const openTime = START + index * FIVE_MINUTE_MS;
  return { openTime, closeTime: openTime + FIVE_MINUTE_MS, open: close, high: close, low: close, close };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('ingestOneMinuteCandle — seed/live splice (Sprint 3 Task A AC 4)', () => {
  const filter: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 1, op: '>', value: -1 };
  const config = buildConfig({ entry_filters: [filter] });

  // 3 native 5m bars seeded -> watermark at START + 3*5m, which is exactly
  // the openTime of the 1m candle at index 15 (the 4th 5m bucket's first
  // minute) — the seed/live seam this test is checking.
  function seeded() {
    return seedSignalEngine(config, {
      '5m': [fiveMinuteCandle(0, 100), fiveMinuteCandle(1, 101), fiveMinuteCandle(2, 102)],
    });
  }

  it('accepts the first live bar that exactly continues the native seed — no dup, no gap warning', () => {
    const logger = makeLogger();
    let state = seeded();
    for (let i = 15; i < 20; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 200), logger).state;
    }

    expect(state.candlesByTimeframe['5m']).toHaveLength(4); // 3 seeded + 1 newly closed
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops a live bucket that is already covered by the seed (no duplicate append)', () => {
    // A native seed that already includes the 4th 5m bar (indices 15-19) —
    // live ticks for that same span must not re-append it.
    const state = seedSignalEngine(config, {
      '5m': [
        fiveMinuteCandle(0, 100),
        fiveMinuteCandle(1, 101),
        fiveMinuteCandle(2, 102),
        fiveMinuteCandle(3, 103),
      ],
    });
    const logger = makeLogger();
    let next = state;
    for (let i = 15; i < 20; i++) {
      next = ingestOneMinuteCandle(config, next, oneMinuteCandle(i, 200), logger).state;
    }

    expect(next.candlesByTimeframe['5m']).toHaveLength(4); // unchanged — the live bucket was already in the seed
  });

  it('logs a WARN and resyncs when a live bucket arrives past a gap (skipped bars)', () => {
    const logger = makeLogger();
    let state = seeded();
    // Skip straight to the 5th 5m bucket (indices 20-24), never feeding the
    // 4th (indices 15-19) — a genuine gap in the closed-bar stream.
    for (let i = 20; i < 25; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 200), logger).state;
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeframe: '5m' }),
      expect.stringContaining('gap'),
    );
    expect(state.candlesByTimeframe['5m']).toHaveLength(4); // 3 seeded + the 5th bucket (resynced)
  });
});

describe('ingestOneMinuteCandle — live-continuity dedup, input duplicate (Sprint 3 Task A AC 4)', () => {
  it('feeding the exact same 1m candle twice does not double-count it', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '1m', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter] });
    let state = createSignalEngine(config);

    state = ingestOneMinuteCandle(config, state, oneMinuteCandle(0, 100)).state;
    state = ingestOneMinuteCandle(config, state, oneMinuteCandle(1, 101)).state;
    const afterFirstTwo = state.candlesByTimeframe['1m']?.length;

    state = ingestOneMinuteCandle(config, state, oneMinuteCandle(1, 101)).state; // duplicate

    expect(state.candlesByTimeframe['1m']).toHaveLength(afterFirstTwo as number);
  });
});

describe('ingestOneMinuteCandle — re-emission dedup, output duplicate (Sprint 3 Task A AC 4)', () => {
  it('does not double-append a bucket that aggregateCandles re-emits on the following tick, before pruning evicts it from the buffer', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter] });
    const seeded = seedSignalEngine(config, {
      '5m': [fiveMinuteCandle(0, 100), fiveMinuteCandle(1, 101), fiveMinuteCandle(2, 102)],
    });

    let state = seeded;
    // Through index 20: one tick INTO the next (5th) bucket. At tick 20,
    // aggregateCandles still re-derives the just-completed 4th bucket
    // (indices 15-19, still in the buffer) before this tick's pruning step
    // runs — the watermark check must drop that re-emission, not append it.
    for (let i = 15; i <= 20; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 200)).state;
    }

    expect(state.candlesByTimeframe['5m']).toHaveLength(4); // 3 seeded + bucket4 exactly once
  });
});

describe('ingestOneMinuteCandle — buffer pruning by bucket boundary, not count (Sprint 3 Task A AC 4)', () => {
  it('keeps emitting new 1h bars across many hours of live ticks', () => {
    const filter: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter] });
    let state = createSignalEngine(config);

    const HOURS = 4;
    for (let i = 0; i < HOURS * 60; i++) {
      state = ingestOneMinuteCandle(config, state, oneMinuteCandle(i, 100 + i)).state;
    }

    // A count-based buffer trim (rather than by bucket boundary) risks
    // dropping candles an unfinished bucket still needs, silently starving
    // the timeframe of new bars after the first one or two hours — this is
    // the regression this test guards against.
    expect(state.candlesByTimeframe['1h']).toHaveLength(HOURS);
  });
});

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { checkAggregation } from '../../src/replay/aggregationCheck.js';
import { loadCandles } from '../../src/replay/candleCsvLoader.js';
import type { Candle } from '../../src/candles/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures/binance-data/csv');
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 5 * ONE_MINUTE_MS;

function oneMinuteCandle(index: number, close: number): Candle {
  const openTime = index * ONE_MINUTE_MS;
  return { openTime, closeTime: openTime + ONE_MINUTE_MS, open: close, high: close, low: close, close };
}

describe('checkAggregation — Sprint 3 Task B, synthetic', () => {
  it('reports zero mismatches when local aggregation matches native exactly', () => {
    const oneMinute = Array.from({ length: 5 }, (_, i) => oneMinuteCandle(i, 100 + i));
    // Matches exactly what aggregateCandles derives from the 5 one-minute
    // candles above: open=first, close=last, high=max, low=min.
    const native: Candle[] = [
      { openTime: 0, closeTime: FIVE_MINUTE_MS, open: 100, high: 104, low: 100, close: 104 },
    ];
    const report = checkAggregation(oneMinute, native, '5m');
    expect(report.mismatches).toEqual([]);
    expect(report.comparedBuckets).toBe(1);
    expect(report.localOnlyEdgeBuckets).toEqual([]);
    expect(report.nativeOnlyEdgeBuckets).toEqual([]);
  });

  it('reports exactly one mismatch when a native field is corrupted', () => {
    const oneMinute = Array.from({ length: 5 }, (_, i) => oneMinuteCandle(i, 100 + i));
    const corruptedNative: Candle[] = [
      { openTime: 0, closeTime: FIVE_MINUTE_MS, open: 100, high: 999, low: 100, close: 104 },
    ];
    const report = checkAggregation(oneMinute, corruptedNative, '5m');
    expect(report.mismatches).toEqual([{ bucketOpenTime: 0, field: 'high', local: 104, native: 999 }]);
  });

  it('does not report false-positive mismatches for edge buckets present in only one series', () => {
    // 10 one-minute candles -> local aggregation has 2 five-minute buckets
    // (0 and 5). Native only covers bucket 0 -> bucket 5 is a local-only edge.
    const oneMinute = Array.from({ length: 10 }, (_, i) => oneMinuteCandle(i, 100 + i));
    const native: Candle[] = [
      { openTime: 0, closeTime: FIVE_MINUTE_MS, open: 100, high: 104, low: 100, close: 104 },
    ];
    const report = checkAggregation(oneMinute, native, '5m');
    expect(report.mismatches).toEqual([]);
    expect(report.localOnlyEdgeBuckets).toEqual([FIVE_MINUTE_MS]);
    expect(report.nativeOnlyEdgeBuckets).toEqual([]);
  });

  it('reports a native-only edge bucket when native extends further than local', () => {
    const oneMinute = Array.from({ length: 5 }, (_, i) => oneMinuteCandle(i, 100 + i));
    const native: Candle[] = [
      { openTime: 0, closeTime: FIVE_MINUTE_MS, open: 100, high: 104, low: 100, close: 104 },
      { openTime: FIVE_MINUTE_MS, closeTime: 2 * FIVE_MINUTE_MS, open: 200, high: 210, low: 195, close: 205 },
    ];
    const report = checkAggregation(oneMinute, native, '5m');
    expect(report.mismatches).toEqual([]);
    expect(report.nativeOnlyEdgeBuckets).toEqual([FIVE_MINUTE_MS]);
  });
});

describe('checkAggregation — Sprint 3 Task B, real fixture data (AC #2)', () => {
  it.each(['5m', '15m', '30m', '1h'] as const)(
    'local 1m->%s aggregation matches native Binance klines to the tick for a full real day',
    (timeframe) => {
      const from = Date.UTC(2026, 7, 1, 0, 0, 0);
      const to = Date.UTC(2026, 7, 2, 0, 0, 0);
      const oneMinute = loadCandles({ dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe: '1m' }, from, to);
      const native = loadCandles({ dir: FIXTURES_DIR, symbol: 'ETHUSDT', timeframe }, from, to);

      const report = checkAggregation(oneMinute, native, timeframe);

      expect(report.mismatches).toEqual([]);
      expect(report.comparedBuckets).toBeGreaterThan(0);
    },
  );
});

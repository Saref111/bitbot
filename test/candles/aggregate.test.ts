import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aggregateCandles } from '../../src/candles/aggregate.js';
import type { Candle, Timeframe } from '../../src/candles/types.js';

const ONE_MINUTE_MS = 60_000;

function oneMinuteCandle(openTime: number, close: number): Candle {
  return {
    openTime,
    closeTime: openTime + ONE_MINUTE_MS,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
  };
}

describe('aggregateCandles — basic shape', () => {
  it('aggregates exactly 5 aligned 1m candles into one 5m candle', () => {
    const start = Date.UTC(2026, 0, 1, 13, 0, 0);
    const candles = [
      oneMinuteCandle(start, 100),
      oneMinuteCandle(start + ONE_MINUTE_MS, 101),
      oneMinuteCandle(start + 2 * ONE_MINUTE_MS, 99),
      oneMinuteCandle(start + 3 * ONE_MINUTE_MS, 103),
      oneMinuteCandle(start + 4 * ONE_MINUTE_MS, 102),
    ];

    const result = aggregateCandles(candles, '5m');

    expect(result).toHaveLength(1);
    const bar = result[0];
    expect(bar?.openTime).toBe(start);
    expect(bar?.closeTime).toBe(start + 5 * ONE_MINUTE_MS);
    expect(bar?.open).toBeCloseTo(candles[0]?.open ?? NaN, 9);
    expect(bar?.close).toBeCloseTo(candles[4]?.close ?? NaN, 9);
    expect(bar?.high).toBeCloseTo(103.2, 9); // max of the five highs (103 + 0.2)
    expect(bar?.low).toBeCloseTo(98.8, 9); // min of the five lows (99 - 0.2)
  });

  it('drops an incomplete trailing group (not yet closed)', () => {
    const start = Date.UTC(2026, 0, 1, 13, 0, 0);
    const candles = [
      oneMinuteCandle(start, 100),
      oneMinuteCandle(start + ONE_MINUTE_MS, 101),
      oneMinuteCandle(start + 2 * ONE_MINUTE_MS, 99),
    ]; // only 3 of 5 needed for a 5m bar

    expect(aggregateCandles(candles, '5m')).toHaveLength(0);
  });

  it('drops an incomplete leading group when input does not start on a boundary', () => {
    const misalignedStart = Date.UTC(2026, 0, 1, 13, 2, 0); // 13:02, not a 5m boundary
    const candles = Array.from({ length: 8 }, (_, i) =>
      oneMinuteCandle(misalignedStart + i * ONE_MINUTE_MS, 100 + i),
    ); // covers 13:02..13:09 -> only 13:05-13:10 is a full aligned bucket

    const result = aggregateCandles(candles, '5m');
    expect(result).toHaveLength(1);
    expect(result[0]?.openTime).toBe(Date.UTC(2026, 0, 1, 13, 5, 0));
  });

  it('aggregates two consecutive complete 15m groups from 30 aligned 1m candles', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const candles = Array.from({ length: 30 }, (_, i) =>
      oneMinuteCandle(start + i * ONE_MINUTE_MS, 100 + i * 0.1),
    );

    const result = aggregateCandles(candles, '15m');
    expect(result).toHaveLength(2);
    expect(result[0]?.openTime).toBe(start);
    expect(result[1]?.openTime).toBe(start + 15 * ONE_MINUTE_MS);
  });
});

const timeframeDurations: Record<Exclude<Timeframe, '1m'>, number> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
};

describe('aggregateCandles — property invariants (MVP §13.1)', () => {
  it('N consecutive aligned 1m candles collapse into exactly one higher-timeframe bar', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Exclude<Timeframe, '1m'>>('5m', '15m', '30m', '1h'),
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.double({ min: 1, max: 100_000, noNaN: true }), { minLength: 1, maxLength: 1 }),
        (timeframe, groupCount, seedArr) => {
          const minutesPerGroup = timeframeDurations[timeframe];
          const durationMs = minutesPerGroup * ONE_MINUTE_MS;
          const start = Math.floor((seedArr[0] ?? 0) / durationMs) * durationMs;
          const totalCandles = groupCount * minutesPerGroup;
          const candles = Array.from({ length: totalCandles }, (_, i) =>
            oneMinuteCandle(start + i * ONE_MINUTE_MS, 100 + i),
          );

          const result = aggregateCandles(candles, timeframe);
          expect(result).toHaveLength(groupCount);
        },
      ),
    );
  });

  it('each aggregated bar keeps the first open, the last close, the max high and the min low of its group', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }).chain((groupCount) =>
          fc
            .array(
              fc.record({
                open: fc.double({ min: 1, max: 100_000, noNaN: true }),
                high: fc.double({ min: 1, max: 100_000, noNaN: true }),
                low: fc.double({ min: 1, max: 100_000, noNaN: true }),
                close: fc.double({ min: 1, max: 100_000, noNaN: true }),
              }),
              { minLength: groupCount * 5, maxLength: groupCount * 5 },
            )
            .map((ohlc) => ({ groupCount, ohlc })),
        ),
        ({ groupCount, ohlc }) => {
          const start = Date.UTC(2026, 0, 1, 0, 0, 0);
          const candles: Candle[] = ohlc.map((c, i) => ({
            openTime: start + i * ONE_MINUTE_MS,
            closeTime: start + (i + 1) * ONE_MINUTE_MS,
            open: c.open,
            high: Math.max(c.open, c.high, c.low, c.close),
            low: Math.min(c.open, c.high, c.low, c.close),
            close: c.close,
          }));

          const result = aggregateCandles(candles, '5m');
          expect(result).toHaveLength(groupCount);

          result.forEach((bar, groupIndex) => {
            const group = candles.slice(groupIndex * 5, groupIndex * 5 + 5);
            const firstCandle = group[0];
            const lastCandle = group[4];
            if (!firstCandle || !lastCandle) throw new Error('group must have 5 candles');
            expect(bar.open).toBeCloseTo(firstCandle.open, 9);
            expect(bar.close).toBeCloseTo(lastCandle.close, 9);
            expect(bar.high).toBeCloseTo(Math.max(...group.map((c) => c.high)), 9);
            expect(bar.low).toBeCloseTo(Math.min(...group.map((c) => c.low)), 9);
          });
        },
      ),
    );
  });
});

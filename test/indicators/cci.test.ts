import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeCciSeries } from '../../src/indicators/cci.js';
import type { Candle } from '../../src/candles/types.js';

function candle(open: number, high: number, low: number, close: number): Candle {
  return { openTime: 0, closeTime: 0, open, high, low, close };
}

// Synthetic OHLC series; expected CCI(20) values are independently computed
// from the exact TypicalPrice/SMA/MeanDeviation formula (MVP §13.2), not
// transcribed by hand.
const CANDLES: Candle[] = [
  candle(99.8, 100.5, 99.5, 100),
  candle(101.536, 102.286, 101.186, 101.736),
  candle(103.0918, 103.8918, 102.7918, 103.2918),
  candle(104.3074, 105.0074, 103.9574, 104.5074),
  candle(105.0597, 105.8097, 104.7597, 105.2597),
  candle(105.277, 106.077, 104.927, 105.477),
  candle(104.9465, 105.6465, 104.6465, 105.1465),
  candle(104.1154, 104.8654, 103.7654, 104.3154),
  candle(102.8864, 103.6864, 102.5864, 103.0864),
  candle(101.4056, 102.1056, 101.0556, 101.6056),
  candle(99.8472, 100.5972, 99.5472, 100.0472),
  candle(98.3936, 99.1936, 98.0436, 98.5936),
  candle(97.216, 97.916, 96.916, 97.416),
  candle(96.4549, 97.2049, 96.1049, 96.6549),
  candle(96.2052, 97.0052, 95.9052, 96.4052),
  candle(96.5054, 97.2054, 96.1554, 96.7054),
  candle(97.3334, 98.0834, 97.0334, 97.5334),
  candle(98.609, 99.409, 98.259, 98.809),
  candle(100.2029, 100.9029, 99.9029, 100.4029),
  candle(101.9506, 102.7006, 101.6006, 102.1506),
  candle(103.6708, 104.4708, 103.3708, 103.8708),
  candle(105.1849, 105.8849, 104.8349, 105.3849),
  candle(106.3375, 107.0875, 106.0375, 106.5375),
  candle(107.0125, 107.8125, 106.6625, 107.2125),
  candle(107.1468, 107.8468, 106.8468, 107.3468),
];
const EXPECTED_CCI: Record<number, number> = {
  19: 29.285748,
  20: 65.836675,
  21: 91.238186,
  22: 109.06486,
  23: 115.867332,
  24: 112.537239,
};

describe('computeCciSeries — reference values', () => {
  const series = computeCciSeries(CANDLES, 20);

  it('is null before the warm-up period completes', () => {
    for (let i = 0; i < 19; i++) {
      expect(series[i]).toBeNull();
    }
  });

  it.each(Object.entries(EXPECTED_CCI))(
    'matches the reference value at index %s',
    (index, expected) => {
      expect(series[Number(index)]).toBeCloseTo(expected, 3);
    },
  );
});

describe('computeCciSeries — edge cases', () => {
  it('returns all-null when there is not enough history', () => {
    const series = computeCciSeries(CANDLES.slice(0, 5), 20);
    expect(series).toEqual(new Array(5).fill(null));
  });

  it('is 0 for a perfectly flat window (zero mean deviation)', () => {
    const flatCandles = Array.from({ length: 20 }, () => candle(100, 100, 100, 100));
    const series = computeCciSeries(flatCandles, 20);
    expect(series[19]).toBeCloseTo(0, 9);
  });
});

describe('computeCciSeries — property invariant', () => {
  it('sign matches whether the typical price sits above or below its own SMA', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            low: fc.double({ min: 1, max: 100_000, noNaN: true }),
            spread: fc.double({ min: 0, max: 100, noNaN: true }),
          }),
          { minLength: 20, maxLength: 40 },
        ),
        (rows) => {
          const candles = rows.map((row) => {
            const high = row.low + row.spread;
            const close = row.low + row.spread / 2;
            return candle(close, high, row.low, close);
          });
          const typicalPrices = candles.map((c) => (c.high + c.low + c.close) / 3);
          const series = computeCciSeries(candles, 20);

          for (let i = 19; i < candles.length; i++) {
            const window = typicalPrices.slice(i - 19, i + 1);
            const sma = window.reduce((a, b) => a + b, 0) / 20;
            const meanDeviation = window.reduce((a, b) => a + Math.abs(b - sma), 0) / 20;
            const cci = series[i];
            const typicalPrice = typicalPrices[i];
            if (cci === undefined || typicalPrice === undefined) {
              throw new Error('index out of bounds');
            }
            if (cci === null) throw new Error('expected a computed CCI value');
            if (meanDeviation === 0) {
              expect(cci).toBe(0);
            } else if (typicalPrice > sma) {
              expect(cci).toBeGreaterThan(0);
            } else if (typicalPrice < sma) {
              expect(cci).toBeLessThan(0);
            }
          }
        },
      ),
    );
  });
});

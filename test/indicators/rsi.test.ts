import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeRsiSeries } from '../../src/indicators/rsi.js';

// Classic Wilder RSI(14) worked example (widely published closing-price
// series). Expected values below are independently computed from the exact
// Wilder recursive-smoothing formula (MVP §13.2), not transcribed by hand.
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
];
const EXPECTED_RSI: Record<number, number> = {
  14: 70.464135,
  15: 66.249619,
  16: 66.480942,
  17: 69.346853,
  18: 66.294713,
  19: 57.915021,
};

describe('computeRsiSeries — Wilder(14) reference values', () => {
  const series = computeRsiSeries(WILDER_CLOSES, 14);

  it('is null before the warm-up period completes', () => {
    for (let i = 0; i < 14; i++) {
      expect(series[i]).toBeNull();
    }
  });

  it.each(Object.entries(EXPECTED_RSI))(
    'matches the reference value at index %s',
    (index, expected) => {
      expect(series[Number(index)]).toBeCloseTo(expected, 4);
    },
  );
});

describe('computeRsiSeries — edge cases', () => {
  it('returns all-null when there is not enough history', () => {
    const series = computeRsiSeries([1, 2, 3], 14);
    expect(series).toEqual([null, null, null]);
  });

  it('is 100 for a strictly increasing series (no losses in the window)', () => {
    const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
    const series = computeRsiSeries(closes, 14);
    expect(series[14]).toBeCloseTo(100, 9);
  });

  it('is 0 for a strictly decreasing series (no gains in the window)', () => {
    const closes = Array.from({ length: 16 }, (_, i) => 100 - i);
    const series = computeRsiSeries(closes, 14);
    expect(series[14]).toBeCloseTo(0, 9);
  });

  it('is 50 for a perfectly flat series (0/0, MVP.md does not define this — chosen as neutral)', () => {
    const closes = Array.from({ length: 16 }, () => 100);
    const series = computeRsiSeries(closes, 14);
    expect(series[14]).toBeCloseTo(50, 9);
  });
});

describe('computeRsiSeries — property invariants', () => {
  it('every non-null value is within [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 100_000, noNaN: true }), {
          minLength: 15,
          maxLength: 60,
        }),
        (closes) => {
          const series = computeRsiSeries(closes, 14);
          for (const value of series) {
            if (value !== null) {
              expect(value).toBeGreaterThanOrEqual(0);
              expect(value).toBeLessThanOrEqual(100);
            }
          }
        },
      ),
    );
  });
});

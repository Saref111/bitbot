import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { averageEntry } from '../../src/grid/averageEntry.js';

describe('averageEntry', () => {
  it('averages two equal-size fills', () => {
    expect(
      averageEntry([
        { price: 100, size: 1 },
        { price: 110, size: 1 },
      ]),
    ).toBeCloseTo(105, 9);
  });

  it('weights by fill size', () => {
    expect(
      averageEntry([
        { price: 100, size: 2 },
        { price: 110, size: 1 },
      ]),
    ).toBeCloseTo(103.33333333, 6);
  });

  it('returns the single fill price when there is only one fill', () => {
    expect(averageEntry([{ price: 1901.54, size: 0.05 }])).toBeCloseTo(1901.54, 9);
  });

  it('throws on an empty fill list', () => {
    expect(() => averageEntry([])).toThrow();
  });
});

const fillArb = fc.record({
  price: fc.double({ min: 0.01, max: 100_000, noNaN: true }),
  size: fc.double({ min: 0.0001, max: 1_000, noNaN: true }),
});

describe('averageEntry — property invariant (MVP §13.7)', () => {
  it('is always between the best (lowest) and worst (highest) fill price', () => {
    fc.assert(
      fc.property(fc.array(fillArb, { minLength: 1, maxLength: 20 }), (fills) => {
        const avg = averageEntry(fills);
        const prices = fills.map((fill) => fill.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        // floating-point round trip (price*size/size) can land a hair outside [min, max]
        const epsilon = Math.max(Math.abs(max), 1) * 1e-9;
        expect(avg).toBeGreaterThanOrEqual(min - epsilon);
        expect(avg).toBeLessThanOrEqual(max + epsilon);
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { shouldCancelForRunaway } from '../../src/orchestrator/runaway.js';

describe('shouldCancelForRunaway (MVP §5: GRID_PLACED runaway-cancel)', () => {
  it('does not trigger while price sits at or below P_entry', () => {
    expect(shouldCancelForRunaway(2000, 2000, 0.5)).toBe(false);
    expect(shouldCancelForRunaway(2000, 1900, 0.5)).toBe(false);
  });

  it('triggers once price reaches P_entry * (1 + pct/100)', () => {
    expect(shouldCancelForRunaway(2000, 2010, 0.5)).toBe(true); // exactly at threshold
    expect(shouldCancelForRunaway(2000, 2009.99, 0.5)).toBe(false);
  });

  it('runawayCancelPct: 0 triggers at (and above) P_entry itself — the threshold collapses to it', () => {
    expect(shouldCancelForRunaway(2000, 2000.01, 0)).toBe(true);
    expect(shouldCancelForRunaway(2000, 2000, 0)).toBe(true);
    expect(shouldCancelForRunaway(2000, 1999.99, 0)).toBe(false);
  });
});

describe('shouldCancelForRunaway — property (monotonic threshold)', () => {
  it('is true exactly when currentPrice crosses the computed threshold', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        (pEntry, pct, currentPrice) => {
          const threshold = pEntry * (1 + pct / 100);
          expect(shouldCancelForRunaway(pEntry, currentPrice, pct)).toBe(currentPrice >= threshold);
        },
      ),
    );
  });

  it('a higher runawayCancelPct never triggers when a lower one does not (monotonic in pct)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (pEntry, currentPrice, pctA, pctB) => {
          const [lowerPct, higherPct] = pctA <= pctB ? [pctA, pctB] : [pctB, pctA];
          if (shouldCancelForRunaway(pEntry, currentPrice, higherPct)) {
            expect(shouldCancelForRunaway(pEntry, currentPrice, lowerPct)).toBe(true);
          }
        },
      ),
    );
  });
});

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { shouldCancelForRunaway } from '../../src/orchestrator/runaway.js';

describe('shouldCancelForRunaway — long (MVP §5: GRID_PLACED runaway-cancel)', () => {
  it('does not trigger while price sits at or below P_entry', () => {
    expect(shouldCancelForRunaway(2000, 2000, 0.5, 'long')).toBe(false);
    expect(shouldCancelForRunaway(2000, 1900, 0.5, 'long')).toBe(false);
  });

  it('triggers once price reaches P_entry * (1 + pct/100)', () => {
    expect(shouldCancelForRunaway(2000, 2010, 0.5, 'long')).toBe(true); // exactly at threshold
    expect(shouldCancelForRunaway(2000, 2009.99, 0.5, 'long')).toBe(false);
  });

  it('runawayCancelPct: 0 triggers at (and above) P_entry itself — the threshold collapses to it', () => {
    expect(shouldCancelForRunaway(2000, 2000.01, 0, 'long')).toBe(true);
    expect(shouldCancelForRunaway(2000, 2000, 0, 'long')).toBe(true);
    expect(shouldCancelForRunaway(2000, 1999.99, 0, 'long')).toBe(false);
  });
});

// Sprint 4 Task A, Slice 5: not full mirror-symmetry validation (that's Task
// B's job, per docs/SPRINT_4.md) — just enough concrete assertions to prove
// the 'short' branch is actually wired to the opposite comparison, not
// merely present as dead code. A test suite that stayed green with `long`
// and `short` producing the SAME comparison would still pass every test
// above; these two are what would catch that.
describe('shouldCancelForRunaway — short (mirrors long: grid sits above P_entry, "away" is downward)', () => {
  it('does not trigger while price sits at or above P_entry', () => {
    expect(shouldCancelForRunaway(2000, 2000, 0.5, 'short')).toBe(false);
    expect(shouldCancelForRunaway(2000, 2100, 0.5, 'short')).toBe(false);
  });

  it('triggers once price reaches P_entry * (1 - pct/100)', () => {
    expect(shouldCancelForRunaway(2000, 1990, 0.5, 'short')).toBe(true); // exactly at threshold
    expect(shouldCancelForRunaway(2000, 1990.01, 0.5, 'short')).toBe(false);
  });
});

describe('shouldCancelForRunaway — property (monotonic threshold)', () => {
  it('long: is true exactly when currentPrice crosses the computed threshold', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        (pEntry, pct, currentPrice) => {
          const threshold = pEntry * (1 + pct / 100);
          expect(shouldCancelForRunaway(pEntry, currentPrice, pct, 'long')).toBe(
            currentPrice >= threshold,
          );
        },
      ),
    );
  });

  it('short: is true exactly when currentPrice crosses the computed threshold (mirrored)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        (pEntry, pct, currentPrice) => {
          const threshold = pEntry * (1 - pct / 100);
          expect(shouldCancelForRunaway(pEntry, currentPrice, pct, 'short')).toBe(
            currentPrice <= threshold,
          );
        },
      ),
    );
  });

  it('a higher runawayCancelPct never triggers when a lower one does not (monotonic in pct, long)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        fc.double({ min: 1, max: 200_000, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (pEntry, currentPrice, pctA, pctB) => {
          const [lowerPct, higherPct] = pctA <= pctB ? [pctA, pctB] : [pctB, pctA];
          if (shouldCancelForRunaway(pEntry, currentPrice, higherPct, 'long')) {
            expect(shouldCancelForRunaway(pEntry, currentPrice, lowerPct, 'long')).toBe(true);
          }
        },
      ),
    );
  });
});

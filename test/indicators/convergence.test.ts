import { describe, expect, it } from 'vitest';
import { requiredConvergenceBars } from '../../src/indicators/convergence.js';

describe('requiredConvergenceBars — RSI Wilder decay (docs/SPRINT 3.md Task A)', () => {
  it.each([0.01, 0.001] as const)(
    'is the minimal bar count where the seed-transient decays within tolerance %s',
    (tolerance) => {
      const period = 14;
      const decay = (period - 1) / period;
      const n = requiredConvergenceBars('RSI', period, tolerance);

      // n is minimal: one bar past it decays within tolerance, one bar
      // short of it does not. This is the actual mathematical contract —
      // asserting it directly (rather than a hand-picked literal) also
      // catches a formula bug like a dropped "+period" seed term, since
      // that would produce a bar count whose decay clearly overshoots.
      const transientBars = n - period;
      expect(decay ** transientBars).toBeLessThanOrEqual(tolerance);
      expect(decay ** (transientBars - 1)).toBeGreaterThan(tolerance);
    },
  );

  it('includes the seed itself, not just the decay tail', () => {
    const period = 14;
    // Sanity band around the doc's own approximate figures (SPRINT 3.md:
    // ~62 bars @1%, ~93 bars @0.1%, "+ сам сід ~14 барів") — a band, not an
    // exact literal, since ceil() rounding puts the real number a bar or
    // two past the doc's rough approximation. The point of this test is
    // catching the "62/93 without +period" mistake, not pinning ceil()'s
    // exact output.
    expect(requiredConvergenceBars('RSI', period, 0.01)).toBeGreaterThan(period + 60);
    expect(requiredConvergenceBars('RSI', period, 0.01)).toBeLessThan(period + 70);
    expect(requiredConvergenceBars('RSI', period, 0.001)).toBeGreaterThan(period + 90);
    expect(requiredConvergenceBars('RSI', period, 0.001)).toBeLessThan(period + 100);
  });

  it('a tighter tolerance requires more bars', () => {
    expect(requiredConvergenceBars('RSI', 14, 0.001)).toBeGreaterThan(
      requiredConvergenceBars('RSI', 14, 0.01),
    );
  });
});

describe('requiredConvergenceBars — CCI has no decay tail', () => {
  it('is exactly the period — first computed value is already exact, no seed-transient to wait out', () => {
    expect(requiredConvergenceBars('CCI', 20)).toBe(20);
    expect(requiredConvergenceBars('CCI', 14)).toBe(14);
  });

  it('is independent of tolerance', () => {
    expect(requiredConvergenceBars('CCI', 20, 0.5)).toBe(20);
    expect(requiredConvergenceBars('CCI', 20, 0.0001)).toBe(20);
  });
});

describe('requiredConvergenceBars — unsupported indicator', () => {
  it('throws rather than silently guessing a bar count', () => {
    expect(() => requiredConvergenceBars('MACD', 14)).toThrow(/MACD/);
  });
});

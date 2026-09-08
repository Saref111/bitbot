import { describe, expect, it } from 'vitest';
import { loadCandles } from '../../src/replay/candleCsvLoader.js';
import { computeRsiSeries } from '../../src/indicators/index.js';
import { JUNE_CSV_DIR, JUNE_WINDOW_START_MS } from '../helpers/juneShortBybit.js';

const ONE_HOUR_MS = 60 * 60_000;

/**
 * Sprint 4 Task D — BLOCKER AC: "warm-up depth-fix зроблено", operationalized
 * exactly like Sprint 4 Task C's Slice C6 proof-of-concept (same method,
 * different window — this is the real June reference window, not the
 * Binance-golden-vector one). Non-null is not enough (docs/SPRINT_4.md):
 * this proves the RSI(1h) computed at the June window's own boundary has
 * actually CONVERGED, not merely produced a number.
 */
describe('RSI(1h) warm-up convergence at the real June window boundary — Sprint 4 Task D blocker AC', () => {
  it('|ΔRSI| between a 100h and a 200h pre-roll is < 0.5 at JUNE_WINDOW_START_MS', () => {
    const oneHourCandles = loadCandles(
      { dir: JUNE_CSV_DIR, symbol: 'ETHUSDT', timeframe: '1h' },
      JUNE_WINDOW_START_MS - 200 * ONE_HOUR_MS,
      JUNE_WINDOW_START_MS,
    );
    expect(oneHourCandles).toHaveLength(200);

    const closes200 = oneHourCandles.map((c) => c.close);
    const closes100 = closes200.slice(100); // last 100 of the same 200 real closes — same real endpoint, shorter Wilder warm-up

    const rsiWith200hPreRoll = computeRsiSeries(closes200, 14).at(-1);
    const rsiWith100hPreRoll = computeRsiSeries(closes100, 14).at(-1);
    if (rsiWith200hPreRoll == null || rsiWith100hPreRoll == null) {
      throw new Error('expected both RSI series to be converged (non-null) at their last index');
    }

    console.log(
      `[Task D blocker] RSI(1h) at June window boundary — 100h pre-roll: ${String(rsiWith100hPreRoll)}, 200h pre-roll: ${String(rsiWith200hPreRoll)}, |Δ|: ${String(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll))}`,
    );
    expect(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll)).toBeLessThan(0.5);
  });

  it('|ΔRSI(30m)| between a 100h and a 200h pre-roll is < 0.5 at JUNE_WINDOW_START_MS', () => {
    const THIRTY_MIN_MS = 30 * 60_000;
    const thirtyMinCandles = loadCandles(
      { dir: JUNE_CSV_DIR, symbol: 'ETHUSDT', timeframe: '30m' },
      JUNE_WINDOW_START_MS - 200 * ONE_HOUR_MS,
      JUNE_WINDOW_START_MS,
    );
    const expectedBars = (200 * ONE_HOUR_MS) / THIRTY_MIN_MS;
    expect(thirtyMinCandles).toHaveLength(expectedBars);

    const closes200 = thirtyMinCandles.map((c) => c.close);
    const closes100 = closes200.slice(expectedBars / 2);

    const rsiWith200hPreRoll = computeRsiSeries(closes200, 14).at(-1);
    const rsiWith100hPreRoll = computeRsiSeries(closes100, 14).at(-1);
    if (rsiWith200hPreRoll == null || rsiWith100hPreRoll == null) {
      throw new Error('expected both RSI series to be converged (non-null) at their last index');
    }

    console.log(
      `[Task D blocker] RSI(30m) at June window boundary — 100h pre-roll: ${String(rsiWith100hPreRoll)}, 200h pre-roll: ${String(rsiWith200hPreRoll)}, |Δ|: ${String(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll))}`,
    );
    expect(Math.abs(rsiWith200hPreRoll - rsiWith100hPreRoll)).toBeLessThan(0.5);
  });
});

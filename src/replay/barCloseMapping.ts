import type { Candle } from '../candles/index.js';

/**
 * Sprint 3 Task B: maps an event timestamp T to the candle with
 * closeTime===T. No per-timeframe special-casing needed — Candle.closeTime
 * is always openTime + durationMs for every timeframe including 1h, so
 * closeTime===T and openTime===T-durationMs are the same condition; the
 * AC's "(для 1г — openTime=T-1h)" is a restatement of the general rule,
 * not an exception to implement.
 */
export function findCandleByCloseTime(
  candles: readonly Candle[],
  closeTimeMs: number,
): Candle | undefined {
  return candles.find((candle) => candle.closeTime === closeTimeMs);
}

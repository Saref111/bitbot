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

/**
 * Sprint 3 Task D (extracted from tzSelfCheck.ts's original inline scan,
 * Task B): finds the candle with the largest closeTime <= targetMs — the
 * most-recently-closed bar at or before an event timestamp. Used both to
 * verify a real event lands a few seconds after its triggering bar's close
 * (tzSelfCheck) and to map a real deal-open timestamp onto the bar whose
 * close it corresponds to (dealTiming). `candles` need not be pre-sorted —
 * this sorts its own copy defensively, same as the original inline version.
 */
export function findNearestPrecedingCloseBar(
  candles: readonly Candle[],
  targetMs: number,
): Candle | undefined {
  const sorted = [...candles].sort((a, b) => a.closeTime - b.closeTime);
  let nearest: Candle | undefined;
  for (const candle of sorted) {
    if (candle.closeTime > targetMs) break;
    nearest = candle;
  }
  return nearest;
}

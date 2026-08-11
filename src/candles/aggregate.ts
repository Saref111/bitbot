import { requireAt } from '../util/arrays.js';
import type { Candle, Timeframe } from './types.js';

const ONE_MINUTE_MS = 60_000;

const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  '1m': ONE_MINUTE_MS,
  '5m': 5 * ONE_MINUTE_MS,
  '15m': 15 * ONE_MINUTE_MS,
  '30m': 30 * ONE_MINUTE_MS,
  '1h': 60 * ONE_MINUTE_MS,
};

/**
 * MVP §13.1: one 1m stream is aggregated locally into higher timeframes;
 * indicators are computed on the closed aggregated bar. Only FULL, boundary-
 * aligned groups are emitted — an incomplete trailing (or leading, if the
 * input doesn't start on a boundary) group is dropped rather than emitted
 * early, since it isn't closed yet. Assumes contiguous, gap-free 1m input;
 * data-feed gap handling is a Slice 8 (live feed) concern, not this pure
 * function's job.
 */
export function aggregateCandles(
  oneMinuteCandles: readonly Candle[],
  timeframe: Timeframe,
): Candle[] {
  const durationMs = TIMEFRAME_DURATION_MS[timeframe];
  const candlesPerGroup = durationMs / ONE_MINUTE_MS;

  const groups = new Map<number, Candle[]>();
  for (const candle of oneMinuteCandles) {
    const bucketStart = Math.floor(candle.openTime / durationMs) * durationMs;
    const group = groups.get(bucketStart) ?? [];
    group.push(candle);
    groups.set(bucketStart, group);
  }

  const sortedEntries = [...groups.entries()].sort(([a], [b]) => a - b);
  const result: Candle[] = [];

  for (const [bucketStart, group] of sortedEntries) {
    if (group.length !== candlesPerGroup) continue;

    const sorted = [...group].sort((a, b) => a.openTime - b.openTime);
    const first = requireAt(sorted, 0);
    const last = requireAt(sorted, sorted.length - 1);

    result.push({
      openTime: bucketStart,
      closeTime: bucketStart + durationMs,
      open: first.open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: last.close,
    });
  }

  return result;
}

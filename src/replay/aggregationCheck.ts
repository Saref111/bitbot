import { aggregateCandles } from '../candles/index.js';
import type { Candle, Timeframe } from '../candles/index.js';
import type { AggregationCheckReport, AggregationMismatch } from './types.js';

/**
 * Sprint 3 Task B: cross-checks bitbot's own local 1m->TF aggregation
 * against native Binance klines for the same timeframe. Only compares
 * buckets present in BOTH series — a bucket present in only one (because
 * the loaded native and 1m windows don't extend equally far at an edge)
 * goes into the edge-bucket lists, never mismatches, so an incomplete
 * edge never reads as a fidelity bug.
 */
export function checkAggregation(
  oneMinuteCandles: readonly Candle[],
  nativeCandles: readonly Candle[],
  timeframe: Timeframe,
): AggregationCheckReport {
  const local = aggregateCandles(oneMinuteCandles, timeframe);
  const localByOpenTime = new Map(local.map((c) => [c.openTime, c]));
  const nativeByOpenTime = new Map(nativeCandles.map((c) => [c.openTime, c]));

  const mismatches: AggregationMismatch[] = [];
  const localOnlyEdgeBuckets: number[] = [];
  const nativeOnlyEdgeBuckets: number[] = [];
  let comparedBuckets = 0;

  for (const [openTime, localCandle] of localByOpenTime) {
    const nativeCandle = nativeByOpenTime.get(openTime);
    if (!nativeCandle) {
      localOnlyEdgeBuckets.push(openTime);
      continue;
    }
    comparedBuckets++;
    for (const field of ['open', 'high', 'low', 'close', 'closeTime'] as const) {
      if (localCandle[field] !== nativeCandle[field]) {
        mismatches.push({
          bucketOpenTime: openTime,
          field,
          local: localCandle[field],
          native: nativeCandle[field],
        });
      }
    }
  }

  for (const openTime of nativeByOpenTime.keys()) {
    if (!localByOpenTime.has(openTime)) {
      nativeOnlyEdgeBuckets.push(openTime);
    }
  }

  return {
    timeframe,
    comparedBuckets,
    mismatches,
    localOnlyEdgeBuckets: localOnlyEdgeBuckets.sort((a, b) => a - b),
    nativeOnlyEdgeBuckets: nativeOnlyEdgeBuckets.sort((a, b) => a - b),
  };
}

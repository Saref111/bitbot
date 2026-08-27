import { findNearestPrecedingCloseBar } from './barCloseMapping.js';
import type { DealSegment, DealTimingReport, DealTimingResult, ReplayBarResult } from './types.js';

const ONE_MINUTE_MS = 60_000;

/**
 * Sprint 3 Task D: for each validatable real deal (DealSegment), checks
 * whether bitbot's own filter AND (entrySignal) fired within toleranceBars
 * of the real Survivor deal-open, on real market data.
 *
 * Triangulation with Task C (indicator-layer golden vector): if Task C's
 * GoldenVectorDiffReport.allWithinTolerance is true but this report's
 * matchedCount < totalCount, the discrepancy points at the deal machine
 * (orchestrator), not the filters/indicators — Task C already validated the
 * filter layer in isolation on the same real market, so a timing miss here
 * with Task C green is evidence the bug is in how the deal state machine
 * consumes a correct signal, not in the signal itself.
 */
export function compareDealTiming(
  bars: readonly ReplayBarResult[],
  segments: readonly DealSegment[],
  toleranceBars = 1,
): DealTimingReport {
  const sortedBars = [...bars].sort((a, b) => a.candle.closeTime - b.candle.closeTime);
  const candles = sortedBars.map((b) => b.candle);

  const deals: DealTimingResult[] = segments.map((segment) => {
    const realBar = findNearestPrecedingCloseBar(candles, segment.realOpenMs);
    if (!realBar) {
      throw new Error(
        `compareDealTiming: no candle at or before realOpenMs for deal "${segment.dealId}" — replay window doesn't cover this deal`,
      );
    }
    const realBarCloseMs = realBar.closeTime;

    const segmentBars = sortedBars.filter(
      (b) => b.candle.closeTime > segment.segmentStartMs && b.candle.closeTime <= segment.segmentEndMs,
    );
    const firstEntry = segmentBars.find((b) => b.entrySignal !== null);

    if (!firstEntry) {
      return {
        dealId: segment.dealId,
        realOpenMs: segment.realOpenMs,
        realBarCloseMs,
        bitbotBarCloseMs: null,
        offsetBars: null,
        withinTolerance: false,
      };
    }

    const bitbotBarCloseMs = firstEntry.candle.closeTime;
    const rawOffsetMs = bitbotBarCloseMs - realBarCloseMs;
    if (!Number.isInteger(rawOffsetMs / ONE_MINUTE_MS)) {
      throw new Error(
        `compareDealTiming: offset between bitbot bar close (${String(bitbotBarCloseMs)}) and real bar close (${String(realBarCloseMs)}) for deal "${segment.dealId}" is not a whole number of 1m bars — both sides should already be on the bar-close grid`,
      );
    }
    const offsetBars = rawOffsetMs / ONE_MINUTE_MS;

    return {
      dealId: segment.dealId,
      realOpenMs: segment.realOpenMs,
      realBarCloseMs,
      bitbotBarCloseMs,
      offsetBars,
      withinTolerance: Math.abs(offsetBars) <= toleranceBars,
    };
  });

  return {
    deals,
    matchedCount: deals.filter((d) => d.withinTolerance).length,
    totalCount: deals.length,
  };
}

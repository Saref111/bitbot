import type { FilterDumpRow, ReplayBarResult } from './types.js';

/**
 * Sprint 3 Task C, AC #4: groups consecutive 1m bars by
 * filterStates[filterIndex]?.since, emitting one row per DISTINCT since
 * value — i.e. one row per closed bar of the filter's OWN timeframe, the
 * same cadence a human zooming into that filter's own chart on Veles would
 * see (a 1h filter -> ~24 rows/day, 30m -> ~48, 15m -> ~96). This is the
 * granularity the per-bar spot-check AC actually needs to compare against
 * — not raw 1m rows, which would just repeat the same latched value/active
 * flag dozens of times between real transitions.
 */
export function buildFilterDump(
  bars: readonly ReplayBarResult[],
  filterIndex: number,
): FilterDumpRow[] {
  const rows: FilterDumpRow[] = [];
  let lastSince: number | null = null;
  let hasAny = false;

  for (const bar of bars) {
    const state = bar.filterStates[filterIndex];
    const since = state ? state.since : null;

    if (!hasAny || since !== lastSince) {
      rows.push({
        // Still-warming-up bars (state === null) have no real "since" yet
        // — fall back to this bar's own closeTime so every row still has a
        // meaningful, monotonically-increasing timestamp to print.
        sinceCloseTime: since ?? bar.candle.closeTime,
        value: bar.filterValues[filterIndex] ?? null,
        active: state?.active ?? false,
      });
      lastSince = since;
      hasAny = true;
    }
  }

  return rows;
}

import { TIMEFRAME_DURATION_MS } from '../candles/index.js';
import type { EntryFilter } from '../config/index.js';
import type { FilterChannelCount, FilterVector, ReplayBarResult } from './types.js';

/**
 * Sprint 3 Task C: counts, per filter channel, how many of that channel's
 * OWN native-timeframe bars were latched active — NOT how many 1m bars the
 * latch happened to hold active. Confirmed against the real golden vector
 * (docs/SPRINT 3.md §2): ExampleExchange' own channel counts decompose cleanly
 * against each filter's OWN timeframe bar count over the window (e.g.
 * RSI(1h) 474/720 ≈ 66%, matching its <55 threshold), not against 43200
 * 1m bars — a latch held active for one native bar spans ~durationMs/60000
 * consecutive 1m bars, so counting at 1m cadence would inflate every
 * non-1m channel by that same multiplier (RSI(1h) would read ~60x too high).
 *
 * A bar counts for a channel only when candle.closeTime lands exactly on
 * that channel's own timeframe boundary (closeTime % durationMs === 0) —
 * the same instant applyBarClose re-evaluates that filter. For '1m'
 * channels every bar satisfies this trivially, so RSI(1m) is unaffected.
 *
 * AND stays 1m-cadence on both sides (entry is re-checked every 1m tick,
 * MVP §5) — reuses entrySignal rather than re-deriving allFiltersActive a
 * second time, so there is only ever one definition of "AND" to drift.
 */
export function computeFilterVector(
  entryFilters: readonly EntryFilter[],
  bars: readonly ReplayBarResult[],
): FilterVector {
  const channels: FilterChannelCount[] = entryFilters.map((filter, index) => {
    const durationMs = TIMEFRAME_DURATION_MS[filter.timeframe];
    const ownTimeframeBars = bars.filter((b) => b.candle.closeTime % durationMs === 0);
    const activeBars = ownTimeframeBars.filter((b) => b.filterStates[index]?.active === true).length;

    return {
      indicator: filter.indicator,
      timeframe: filter.timeframe,
      period: filter.period,
      op: filter.op,
      value: filter.value,
      activeBars,
      totalBars: ownTimeframeBars.length,
    };
  });

  return {
    channels,
    andBars: bars.filter((b) => b.entrySignal !== null).length,
    totalBars: bars.length,
  };
}

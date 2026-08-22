import type { Timeframe } from '../candles/index.js';
import type { EntryFilter } from '../config/index.js';
import { requiredConvergenceBars } from '../indicators/index.js';
import { CONVERGENCE_TOLERANCE } from './constants.js';
import type { SignalEngineState } from './types.js';

export interface WarmupSelfCheckEntry {
  indicator: string;
  timeframe: Timeframe;
  period: number;
  value: number | null;
  bars: number;
  requiredBars: number;
  /** bars >= requiredBars, independent of whatever warm-up depth was configured — under-configuring or a fetch-gap shows up here as false even if the fetch itself "succeeded". */
  converged: boolean;
}

/**
 * Sprint 3 Task A: one entry per config.entry_filters filter, pure (the
 * caller — liveFeed.ts — decides whether/how to log it), mirroring
 * filters/snapshot.ts's pure-builder-then-caller-logs split.
 */
export function buildWarmupSelfCheck(
  entryFilters: readonly EntryFilter[],
  candlesByTimeframe: SignalEngineState['candlesByTimeframe'],
  filterValues: readonly (number | null)[],
): WarmupSelfCheckEntry[] {
  return entryFilters.map((filter, index) => {
    const bars = candlesByTimeframe[filter.timeframe]?.length ?? 0;
    const requiredBars = requiredConvergenceBars(filter.indicator, filter.period, CONVERGENCE_TOLERANCE);

    return {
      indicator: filter.indicator,
      timeframe: filter.timeframe,
      period: filter.period,
      value: filterValues[index] ?? null,
      bars,
      requiredBars,
      converged: bars >= requiredBars,
    };
  });
}

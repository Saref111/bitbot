import type { Timeframe } from '../candles/index.js';
import type { EntryFilter } from '../config/index.js';
import { allFiltersActive } from './signals.js';
import type { FilterSignal } from './types.js';

export interface FilterSnapshotEntry {
  indicator: string;
  tf: Timeframe;
  /** Latched value of this filter's own timeframe; null while its indicator (or the timeframe itself) hasn't warmed up yet. */
  value: number | null;
  threshold: number;
  pass: boolean;
}

export interface FilterSnapshot {
  /** Timeframe whose bar close triggered this reevaluation — NOT necessarily every filter's own tf. */
  triggeredTf: Timeframe;
  closeTimeMs: number;
  closeTimeIso: string;
  /** Every filter's latched state, in config.entry_filters order — not just the one that just updated. */
  filters: FilterSnapshotEntry[];
  gatePassed: boolean;
  /** First filter that fails, in gate order (high->low TF); null when gatePassed. */
  blockedBy: FilterSnapshotEntry | null;
}

/**
 * DEBUG-only visibility into the bar_close filter state machine (MVP §5).
 * Pure — no logging/IO here; the caller (signalEngine) decides whether and
 * where to emit it.
 */
export function buildFilterSnapshot(
  filters: readonly EntryFilter[],
  states: readonly (FilterSignal | null)[],
  values: readonly (number | null)[],
  triggeredTf: Timeframe,
  closeTime: number,
  gateOrder: readonly Timeframe[],
): FilterSnapshot {
  const entries: FilterSnapshotEntry[] = filters.map((filter, index) => ({
    indicator: filter.indicator,
    tf: filter.timeframe,
    value: values[index] ?? null,
    threshold: filter.value,
    pass: states[index]?.active ?? false,
  }));

  const gatePassed = allFiltersActive(states);
  const blockedBy = gatePassed
    ? null
    : ([...entries]
        .sort((a, b) => gateOrder.indexOf(a.tf) - gateOrder.indexOf(b.tf))
        .find((entry) => !entry.pass) ?? null);

  return {
    triggeredTf,
    closeTimeMs: closeTime,
    closeTimeIso: new Date(closeTime).toISOString(),
    filters: entries,
    gatePassed,
    blockedBy,
  };
}

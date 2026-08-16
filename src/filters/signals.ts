import type { EntryFilter } from '../config/index.js';
import type { BarCloseEvent, FilterSignal } from './types.js';

/**
 * MVP §5: each filter is recomputed on the closed bar of its OWN timeframe;
 * a filter on a different timeframe is left completely untouched, which is
 * exactly the persistence rule ("сигнал живе до наступного закриття свого
 * ТФ") — there is nothing else to implement for it beyond not touching it.
 */
export function applyBarClose(
  filters: readonly EntryFilter[],
  priorStates: readonly (FilterSignal | null)[],
  event: BarCloseEvent,
): (FilterSignal | null)[] {
  return filters.map((filter, index) => {
    if (filter.timeframe !== event.timeframe) {
      return priorStates[index] ?? null;
    }

    if (!event.indicatorValues.has(index)) {
      throw new Error(
        `applyBarClose: missing indicator value for filter ${String(index)} (${filter.indicator} ${filter.timeframe})`,
      );
    }

    const value = event.indicatorValues.get(index) ?? null;
    if (value === null) {
      // Indicator hasn't warmed up yet (MVP §13.2) — evaluated, not active.
      return { active: false, since: event.closeTime };
    }

    const active = filter.op === '<' ? value < filter.value : value > filter.value;
    return { active, since: event.closeTime };
  });
}

/** MVP §3/§5: entry requires ALL filters active (AND); an empty list means enter immediately. */
export function allFiltersActive(states: readonly (FilterSignal | null)[]): boolean {
  return states.every((state) => state !== null && state.active);
}

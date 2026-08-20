import { aggregateCandles } from '../candles/index.js';
import { requireAt } from '../util/index.js';
import type { Candle } from '../candles/index.js';
import type { Config, EntryFilter } from '../config/index.js';
import type { EntrySignal, IndicatorComputer, SignalEngineState } from './types.js';
import { TIMEFRAME_ORDER } from './constants.js';
import { computeCciSeries, computeRsiSeries } from '../indicators/index.js';
import { allFiltersActive, applyBarClose, buildFilterSnapshot } from '../filters/index.js';
import { createNoopLogger } from '../logging/index.js';
import type { Logger } from '../logging/index.js';

export function createSignalEngine(config: Config): SignalEngineState {
  return {
    oneMinuteCandles: [],
    lastBarCount: {},
    filterStates: config.entry_filters.map(() => null),
    filterValues: config.entry_filters.map(() => null),
  };
}

const INDICATOR_COMPUTERS: Record<string, IndicatorComputer> = {
  RSI: (filter, candles) =>
    computeRsiSeries(
      candles.map((c) => c.close),
      filter.period,
    ).at(-1) ?? null,
  CCI: (filter, candles) => computeCciSeries(candles, filter.period).at(-1) ?? null,
};

function computeFilterValue(filter: EntryFilter, candles: readonly Candle[]): number | null {
  const computer = INDICATOR_COMPUTERS[filter.indicator];
  if (!computer) {
    throw new Error(`signalEngine: unsupported indicator '${filter.indicator}'`);
  }
  return computer(filter, candles);
}

/**
 * MVP §5 (WAITING_SIGNAL): folds one freshly-closed 1m candle into the
 * engine. Re-aggregates the whole accumulated 1m history per referenced
 * timeframe on every call (reusing aggregateCandles/computeRsiSeries/
 * computeCciSeries as plain batch functions) rather than maintaining a
 * separate incremental/streaming version of the same logic — warm-up
 * windows are a few hundred bars at most, so this is cheap for a feed that
 * ticks once a minute.
 */
export function ingestOneMinuteCandle(
  config: Config,
  state: SignalEngineState,
  candle: Candle,
  logger: Logger = createNoopLogger(),
): { state: SignalEngineState; entrySignal: EntrySignal | null } {
  const oneMinuteCandles = [...state.oneMinuteCandles, candle];
  const referencedTimeframes = new Set(config.entry_filters.map((filter) => filter.timeframe));
  const lastBarCount = { ...state.lastBarCount };
  let filterStates = state.filterStates;
  let filterValues = state.filterValues;

  for (const timeframe of TIMEFRAME_ORDER) {
    if (!referencedTimeframes.has(timeframe)) continue;

    const aggregated =
      timeframe === '1m' ? oneMinuteCandles : aggregateCandles(oneMinuteCandles, timeframe);
    const previousCount = lastBarCount[timeframe] ?? 0;
    if (aggregated.length <= previousCount) continue; // no new closed bar on this timeframe yet
    lastBarCount[timeframe] = aggregated.length;

    const indicatorValues = new Map<number, number | null>();
    config.entry_filters.forEach((filter, index) => {
      if (filter.timeframe !== timeframe) return;
      indicatorValues.set(index, computeFilterValue(filter, aggregated));
    });

    const closedBar = requireAt(aggregated, aggregated.length - 1);
    filterStates = applyBarClose(config.entry_filters, filterStates, {
      timeframe,
      closeTime: closedBar.closeTime,
      indicatorValues,
    });
    filterValues = config.entry_filters.map((filter, index) =>
      filter.timeframe === timeframe
        ? (indicatorValues.get(index) ?? null)
        : (filterValues[index] ?? null),
    );

    // DEBUG-only (MVP §5/§13.6): a full latched snapshot of every filter's
    // state, not just this timeframe's — pino no-ops below its configured
    // level, so this is free on INFO and above.
    logger.debug(
      buildFilterSnapshot(
        config.entry_filters,
        filterStates,
        filterValues,
        timeframe,
        closedBar.closeTime,
        TIMEFRAME_ORDER,
      ),
      'filter state snapshot (bar_close)',
    );
  }

  const entrySignal = allFiltersActive(filterStates)
    ? { price: candle.close, closeTime: candle.closeTime }
    : null;

  return {
    state: { oneMinuteCandles, lastBarCount, filterStates, filterValues },
    entrySignal,
  };
}

import { aggregateCandles } from '../candles/aggregate.js';
import { computeRsiSeries } from '../indicators/rsi.js';
import { computeCciSeries } from '../indicators/cci.js';
import { applyBarClose, allFiltersActive } from '../filters/signals.js';
import { requireAt } from '../util/arrays.js';
import type { Candle, Timeframe } from '../candles/types.js';
import type { Config, EntryFilter } from '../config/types.js';
import type { EntrySignal, SignalEngineState } from './types.js';

// MVP §5: checked from higher timeframes to lower. The final AND result
// doesn't actually depend on this order (each filter updates independently
// of the others), but processing in this order matches the spec.
const TIMEFRAME_ORDER: readonly Timeframe[] = ['1h', '30m', '15m', '5m', '1m'];

export function createSignalEngine(config: Config): SignalEngineState {
  return {
    oneMinuteCandles: [],
    lastBarCount: {},
    filterStates: config.entry_filters.map(() => null),
  };
}

type IndicatorComputer = (filter: EntryFilter, candles: readonly Candle[]) => number | null;

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
): { state: SignalEngineState; entrySignal: EntrySignal | null } {
  const oneMinuteCandles = [...state.oneMinuteCandles, candle];
  const referencedTimeframes = new Set(config.entry_filters.map((filter) => filter.timeframe));
  const lastBarCount = { ...state.lastBarCount };
  let filterStates = state.filterStates;

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
  }

  const entrySignal = allFiltersActive(filterStates)
    ? { price: candle.close, closeTime: candle.closeTime }
    : null;

  return {
    state: { oneMinuteCandles, lastBarCount, filterStates },
    entrySignal,
  };
}

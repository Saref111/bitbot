import { requireAt } from '../util/index.js';
import type { Candle } from '../candles/index.js';

/**
 * MVP §13.2: CCI = (TypicalPrice - SMA(TypicalPrice, period)) /
 * (0.015 * MeanDeviation(TypicalPrice, period)). A zero mean deviation
 * (perfectly flat window) is treated as CCI=0 — no deviation from the mean
 * is the uncontroversial neutral reading, unlike RSI's 0/100 edge.
 */
export function computeCciSeries(candles: readonly Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array<null>(candles.length).fill(null);
  const typicalPrices = candles.map((c) => (c.high + c.low + c.close) / 3);

  for (let i = period - 1; i < candles.length; i++) {
    const window = typicalPrices.slice(i - period + 1, i + 1);
    const sma = window.reduce((sum, value) => sum + value, 0) / period;
    const meanDeviation = window.reduce((sum, value) => sum + Math.abs(value - sma), 0) / period;
    const typicalPrice = requireAt(typicalPrices, i);

    result[i] = meanDeviation === 0 ? 0 : (typicalPrice - sma) / (0.015 * meanDeviation);
  }

  return result;
}

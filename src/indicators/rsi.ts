import { requireAt } from '../util/arrays.js';

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  // MVP.md does not define the flat-price case (no movement at all in the
  // window); 50 is chosen as the neutral 0/0 convention.
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MVP §13.2: RSI via Wilder's recursive smoothing (NOT a plain moving
 * average recomputed from scratch each step): the first avgGain/avgLoss is
 * a simple mean of the first `period` changes, then each subsequent step
 * folds in the new change with weight 1/period.
 */
export function computeRsiSeries(closes: readonly number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array<null>(closes.length).fill(null);
  if (closes.length <= period) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = requireAt(closes, i) - requireAt(closes, i - 1);
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = requireAt(closes, i) - requireAt(closes, i - 1);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }

  return result;
}

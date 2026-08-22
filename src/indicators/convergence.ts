/**
 * Sprint 3 Task A: how many closed bars a filter's indicator needs before
 * its value has actually converged to what a continuously-running Veles
 * instance would show — distinct from "non-null" (RSI(14) is non-null after
 * 15 bars, but its Wilder seed-transient still dominates the value).
 *
 * RSI: Wilder's recursive smoothing decays its seed-transient geometrically
 * at ((period-1)/period)^N per bar past the seed. Solving for N at a given
 * tolerance gives the bars-past-seed count; +period accounts for the seed
 * itself (the first `period` closes consumed to compute the initial
 * avgGain/avgLoss). CCI has no recursive state — its first computed value
 * (at index period-1) is already exact, no decay tail.
 */
export function requiredConvergenceBars(
  indicator: string,
  period: number,
  tolerance = 0.001,
): number {
  switch (indicator) {
    case 'RSI':
      return Math.ceil(Math.log(tolerance) / Math.log((period - 1) / period)) + period;
    case 'CCI':
      return period;
    default:
      throw new Error(`requiredConvergenceBars: unsupported indicator '${indicator}'`);
  }
}

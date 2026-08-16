import type { Timeframe } from '../candles/index.js';

export interface FilterSignal {
  active: boolean;
  /** closeTime of the bar that set this; stays valid until this filter's own timeframe closes again. */
  since: number;
}

export interface BarCloseEvent {
  timeframe: Timeframe;
  closeTime: number;
  /**
   * Indicator value computed for the closed bar, keyed by filter index.
   * Computing this is the caller's job, not this module's. `null`
   * means the indicator hasn't warmed up yet (mirrors computeRsiSeries/
   * computeCciSeries returning null during warm-up) and is treated as an
   * evaluated-but-inactive result, not an error — a missing key entirely is
   * the actual caller bug and throws.
   */
  indicatorValues: ReadonlyMap<number, number | null>;
}

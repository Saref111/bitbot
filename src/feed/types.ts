import type { Candle, Timeframe } from '../candles/types.js';
import type { FilterSignal } from '../filters/types.js';

export interface SignalEngineState {
  oneMinuteCandles: readonly Candle[];
  lastBarCount: Partial<Record<Timeframe, number>>;
  filterStates: (FilterSignal | null)[];
}

export interface EntrySignal {
  price: number;
  closeTime: number;
}

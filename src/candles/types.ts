import { ONE_MINUTE_MS } from './constants.js';

export const supportedTimeframes = ['1m', '5m', '15m', '30m', '1h'] as const;

export type Timeframe = (typeof supportedTimeframes)[number];

export const TIMEFRAME_DURATION_MS: Record<Timeframe, number> = {
  '1m': ONE_MINUTE_MS,
  '5m': 5 * ONE_MINUTE_MS,
  '15m': 15 * ONE_MINUTE_MS,
  '30m': 30 * ONE_MINUTE_MS,
  '1h': 60 * ONE_MINUTE_MS,
};

export interface Candle {
  /** ms epoch, aligned to the timeframe's boundary. */
  openTime: number;
  /** ms epoch; equals openTime + duration (the next bar's openTime). */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

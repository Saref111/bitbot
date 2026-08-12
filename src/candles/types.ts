import { supportedTimeframes } from '../config/schema.js';

export type Timeframe = (typeof supportedTimeframes)[number];

const ONE_MINUTE_MS = 60_000;

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

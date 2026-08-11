import { supportedTimeframes } from '../config/schema.js';

export type Timeframe = (typeof supportedTimeframes)[number];

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

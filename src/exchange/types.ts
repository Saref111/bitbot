import type { Candle, Timeframe } from '../candles/types.js';

/**
 * Thrown by ExchangeAdapter.cancelOrder when the order is already gone
 * (filled or otherwise resolved) rather than still cancellable — Slice 9's
 * TP/SL reprice treats this as "it just filled," not a real failure.
 */
export class OrderNotFoundError extends Error {}

export interface MarketInfo {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
}

export interface Position {
  symbol: string;
  /** null = flat (no open position). */
  side: 'long' | 'short' | null;
  contracts: number;
  entryPrice: number | null;
  liquidationPrice: number | null;
}

export interface CreateOrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  amount: number;
  /** Required for type: 'limit'. */
  price?: number;
  clientOrderId: string;
  reduceOnly?: boolean;
}

export interface PlacedOrder {
  id: string;
  clientOrderId: string;
  status: string;
}

export interface OpenOrder {
  id: string;
  clientOrderId: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  filled: number;
  status: string;
  reduceOnly: boolean;
}

export interface FundingRateInfo {
  fundingRate: number;
  fundingTimestamp: number | null;
}

export interface ExchangeAdapter {
  setupSymbol: (
    symbol: string,
    leverage: number,
    marginMode: 'cross' | 'isolated',
  ) => Promise<void>;
  getMarketInfo: (symbol: string) => Promise<MarketInfo>;
  fetchOHLCV: (
    symbol: string,
    timeframe: Timeframe,
    since?: number,
    limit?: number,
  ) => Promise<Candle[]>;
  fetchPosition: (symbol: string) => Promise<Position>;
  createOrder: (params: CreateOrderParams) => Promise<PlacedOrder>;
  fetchOpenOrders: (symbol: string) => Promise<OpenOrder[]>;
  /**
   * Cancels ONE specific resting order by clientOrderId, unlike cancelAll —
   * needed for TP/SL reprice (Slice 9), which must not disturb the other
   * still-live grid rungs on the same symbol.
   */
  cancelOrder: (symbol: string, clientOrderId: string) => Promise<void>;
  cancelAll: (symbol: string) => Promise<void>;
  fetchFundingRate: (symbol: string) => Promise<FundingRateInfo>;
}

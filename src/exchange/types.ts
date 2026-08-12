import type { Candle, Timeframe } from '../candles/types.js';

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
  setupSymbol(symbol: string, leverage: number, marginMode: 'cross' | 'isolated'): Promise<void>;
  getMarketInfo(symbol: string): Promise<MarketInfo>;
  fetchOHLCV(
    symbol: string,
    timeframe: Timeframe,
    since?: number,
    limit?: number,
  ): Promise<Candle[]>;
  fetchPosition(symbol: string): Promise<Position>;
  createOrder(params: CreateOrderParams): Promise<PlacedOrder>;
  fetchOpenOrders(symbol: string): Promise<OpenOrder[]>;
  cancelAll(symbol: string): Promise<void>;
  fetchFundingRate(symbol: string): Promise<FundingRateInfo>;
}

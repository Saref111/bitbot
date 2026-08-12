import type {
  Market,
  Order,
  OHLCV,
  Position as CcxtPosition,
  FundingRate as CcxtFundingRate,
} from 'ccxt';
import { TIMEFRAME_DURATION_MS } from '../candles/types.js';
import type { Candle, Timeframe } from '../candles/types.js';
import type {
  CreateOrderParams,
  ExchangeAdapter,
  FundingRateInfo,
  MarketInfo,
  OpenOrder,
  PlacedOrder,
  Position,
} from './types.js';

/**
 * Narrow slice of ccxt's Exchange surface that this adapter actually calls —
 * lets unit tests supply a plain mock instead of satisfying ccxt's full
 * (huge) Exchange class shape. A real ccxt.binanceusdm instance structurally
 * satisfies this already (see binanceClient.ts).
 */
export interface CcxtLike {
  loadMarkets: (reload?: boolean) => Promise<unknown>;
  setPositionMode: (hedged: boolean, symbol?: string) => Promise<unknown>;
  setMarginMode: (marginMode: string, symbol?: string) => Promise<unknown>;
  setLeverage: (leverage: number, symbol?: string) => Promise<unknown>;
  market: (symbol: string) => Market;
  fetchOHLCV: (
    symbol: string,
    timeframe?: string,
    since?: number,
    limit?: number,
  ) => Promise<OHLCV[]>;
  fetchPositions: (symbols?: string[]) => Promise<CcxtPosition[]>;
  createOrder: (
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Record<string, unknown>,
  ) => Promise<Order>;
  fetchOpenOrders: (symbol?: string) => Promise<Order[]>;
  cancelAllOrders: (symbol?: string) => Promise<Order[]>;
  fetchFundingRate: (symbol: string) => Promise<CcxtFundingRate>;
}

function toCandle(row: OHLCV, timeframe: Timeframe): Candle {
  const [openTime, open, high, low, close] = row;
  if (
    openTime === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined
  ) {
    throw new Error('binanceAdapter: incomplete OHLCV row from exchange');
  }
  return {
    openTime,
    closeTime: openTime + TIMEFRAME_DURATION_MS[timeframe],
    open,
    high,
    low,
    close,
  };
}

// Binance rejects re-setting a position/margin mode the account is already
// in (e.g. code -4059 "No need to change position side.", -4046 "No need to
// change margin type.") — the desired end state is already reached, so this
// isn't a real failure.
function isNoChangeNeededError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('No need to change');
}

export function createBinanceAdapter(client: CcxtLike): ExchangeAdapter {
  return {
    async setupSymbol(symbol, leverage, marginMode) {
      await client.loadMarkets();
      try {
        await client.setPositionMode(false, symbol); // one-way position mode
      } catch (error) {
        if (!isNoChangeNeededError(error)) throw error;
      }
      try {
        await client.setMarginMode(marginMode, symbol);
      } catch (error) {
        if (!isNoChangeNeededError(error)) throw error;
      }
      await client.setLeverage(leverage, symbol);
    },

    async getMarketInfo(symbol): Promise<MarketInfo> {
      await client.loadMarkets();
      const market = client.market(symbol);
      const tickSize = market?.precision.price;
      const stepSize = market?.precision.amount;
      const minNotional = market?.limits.cost?.min;
      if (tickSize == null || stepSize == null || minNotional == null) {
        throw new Error(`getMarketInfo: incomplete market info for ${symbol}`);
      }
      return { symbol, tickSize, stepSize, minNotional };
    },

    async fetchOHLCV(symbol, timeframe, since, limit) {
      const rows = await client.fetchOHLCV(symbol, timeframe, since, limit);
      return rows.map((row) => toCandle(row, timeframe));
    },

    async fetchPosition(symbol): Promise<Position> {
      // fetchPosition() (singular) is options-only on this ccxt version for
      // binanceusdm; fetchPositions() (plural) is the futures-correct call.
      const positions = await client.fetchPositions([symbol]);
      const position = positions.find((p) => p.symbol === symbol);
      const contracts = position?.contracts ?? 0;
      return {
        symbol,
        side: contracts === 0 ? null : position?.side === 'short' ? 'short' : 'long',
        contracts,
        entryPrice: position?.entryPrice ?? null,
        liquidationPrice: position?.liquidationPrice ?? null,
      };
    },

    async createOrder(params: CreateOrderParams): Promise<PlacedOrder> {
      const order = await client.createOrder(
        params.symbol,
        params.type,
        params.side,
        params.amount,
        params.price,
        {
          clientOrderId: params.clientOrderId,
          ...(params.reduceOnly ? { reduceOnly: true } : {}),
        },
      );
      return {
        id: order.id ?? '',
        clientOrderId: order.clientOrderId ?? params.clientOrderId,
        status: order.status ?? 'unknown',
      };
    },

    async fetchOpenOrders(symbol): Promise<OpenOrder[]> {
      const orders = await client.fetchOpenOrders(symbol);
      return orders.map((order) => ({
        id: order.id ?? '',
        clientOrderId: order.clientOrderId ?? '',
        side: order.side === 'sell' ? 'sell' : 'buy',
        price: order.price ?? 0,
        amount: order.amount ?? 0,
        filled: order.filled ?? 0,
        status: order.status ?? 'unknown',
        reduceOnly: order.reduceOnly ?? false,
      }));
    },

    async cancelAll(symbol) {
      await client.cancelAllOrders(symbol);
    },

    async fetchFundingRate(symbol): Promise<FundingRateInfo> {
      const rate = await client.fetchFundingRate(symbol);
      return {
        fundingRate: rate.fundingRate ?? 0,
        fundingTimestamp: rate.fundingTimestamp ?? null,
      };
    },
  };
}

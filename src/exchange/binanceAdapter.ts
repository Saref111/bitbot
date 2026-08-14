import { OrderNotFound } from 'ccxt';
import type {
  Market,
  Order,
  OHLCV,
  Position as CcxtPosition,
  FundingRate as CcxtFundingRate,
  Trade as CcxtTrade,
  FundingHistory as CcxtFundingHistory,
} from 'ccxt';
import { TIMEFRAME_DURATION_MS } from '../candles/types.js';
import type { Candle, Timeframe } from '../candles/types.js';
import { OrderNotFoundError } from './types.js';
import type {
  CreateOrderParams,
  ExchangeAdapter,
  FundingPayment,
  FundingRateInfo,
  MarketInfo,
  OpenOrder,
  PlacedOrder,
  Position,
  TradeInfo,
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
  cancelOrder: (id: string, symbol?: string, params?: Record<string, unknown>) => Promise<Order>;
  cancelAllOrders: (symbol?: string) => Promise<Order[]>;
  fetchFundingRate: (symbol: string) => Promise<CcxtFundingRate>;
  fetchMyTrades: (symbol?: string, since?: number, limit?: number) => Promise<CcxtTrade[]>;
  fetchFundingHistory: (
    symbol?: string,
    since?: number,
    limit?: number,
  ) => Promise<CcxtFundingHistory[]>;
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

// Slice 9: a crash between createOrder succeeding on the exchange and the
// tick's DB write committing means a retry (recoverDeal re-running the same
// tick) submits the SAME deterministic clientOrderId again. Binance rejects
// that as code -4116 "ClientOrderId is duplicated." rather than silently
// returning the existing order — but a duplicate of an order we ourselves
// already placed with this exact id IS the desired end state, not a
// failure. Verified against Binance testnet (Slice 9) — an earlier guess of
// -4015 turned out to be wrong; matched on the numeric code (stable
// identifier), not the message text.
function isDuplicateClientOrderIdError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('"code":-4116');
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

    // ccxt exposes precision two ways depending on exchange.precisionMode:
    // TICK_SIZE (market.precision.price/amount ARE the tick/step values,
    // e.g. 0.01) or DECIMAL_PLACES (a digit count, e.g. 2, needing 10**-n).
    // binanceusdm reports TICK_SIZE, so reading precision.price/amount
    // directly as tickSize/stepSize below is correct for this exchange
    // specifically — not a generic ccxt assumption.
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
      let order: Order;
      try {
        order = await client.createOrder(
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
      } catch (error) {
        if (!isDuplicateClientOrderIdError(error)) throw error;
        // Idempotent retry: an order with this exact clientOrderId already
        // rests on the exchange (from a pre-crash attempt) — that already IS
        // the desired state. Callers here only ever key off clientOrderId,
        // never this return value's id/status, so a placeholder is enough.
        return { id: '', clientOrderId: params.clientOrderId, status: 'open' };
      }
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

    // ccxt cancels by exchange id positionally; Binance also supports
    // cancelling by clientOrderId via params.origClientOrderId, which is
    // what we have persisted (never the exchange's own id) — mirrors how
    // createOrder threads clientOrderId through params, not a positional
    // arg. Verified against Binance testnet (Slice 9).
    async cancelOrder(symbol, clientOrderId) {
      try {
        await client.cancelOrder('', symbol, { origClientOrderId: clientOrderId });
      } catch (error) {
        if (error instanceof OrderNotFound) {
          throw new OrderNotFoundError(
            `binanceAdapter: order ${clientOrderId} not found (already filled/cancelled)`,
          );
        }
        throw error;
      }
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

    async fetchTrades(symbol, since): Promise<TradeInfo[]> {
      const trades = await client.fetchMyTrades(symbol, since);
      return trades.map((trade) => ({
        timestamp: trade.timestamp ?? 0,
        side: trade.side === 'sell' ? 'sell' : 'buy',
        price: trade.price ?? 0,
        amount: trade.amount ?? 0,
        cost: trade.cost ?? 0,
        feeCost: trade.fee?.cost ?? 0,
        feeCurrency: trade.fee?.currency ?? '',
        takerOrMaker:
          trade.takerOrMaker === 'maker' || trade.takerOrMaker === 'taker'
            ? trade.takerOrMaker
            : 'unknown',
      }));
    },

    // No client-side upper bound and no pagination loop — see computeNet.ts
    // for why the upper bound is intentionally absent. A generous explicit
    // limit (funding accrues every 8h; ~1000 entries covers ~333 days) is
    // simpler than real pagination for a personal-scale MVP deal.
    async fetchFundingHistory(symbol, since): Promise<FundingPayment[]> {
      const history = await client.fetchFundingHistory(symbol, since, 1000);
      return history.map((entry) => ({
        timestamp: entry.timestamp ?? 0,
        amount: entry.amount ?? 0,
      }));
    },
  };
}

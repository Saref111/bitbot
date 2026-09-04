import { NoChange, OrderNotFound } from 'ccxt';
import type { OHLCV, Order } from 'ccxt';
import { TIMEFRAME_DURATION_MS, type Candle, type Timeframe } from '../candles/index.js';
import { OrderNotFoundError } from './errors.js';
import type {
  CcxtLike,
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

function toCandle(row: OHLCV, timeframe: Timeframe): Candle {
  const [openTime, open, high, low, close] = row;
  if (
    openTime === undefined ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined
  ) {
    throw new Error('bybitAdapter: incomplete OHLCV row from exchange');
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

// Unlike Binance (string match on "No need to change"), Bybit gives ccxt
// typed exception classes for this — bybit.js's exceptions.exact table maps
// retCode 110025 ("Position mode is not modified") and 110027 ("Margin is
// not modified") to NoChange, and 110026 ("Cross/isolated margin mode is not
// modified") to MarginModeAlreadySet. A single `instanceof NoChange` check
// covers all three: base/errors.js declares `class MarginModeAlreadySet
// extends NoChange` (lines 68/74) — it's a subclass, not a sibling, so a
// separate `instanceof MarginModeAlreadySet` branch would be dead code.
// Caught by this slice's own sanity check: temporarily dropping such a
// branch left every test green, which is what exposed the subclass
// relationship rather than it being assumed. The desired end state is
// already reached in all three cases, so none of them is a real failure.
function isNoChangeNeededError(error: unknown): boolean {
  return error instanceof NoChange;
}

// PROVISIONAL — not confirmed on real Bybit, awaiting Slice C4. ccxt's
// bybit.js exceptions.exact table (line ~705) lists retCode 12141 as
// BadRequest with retMsg "Duplicate clientOrderId." — a plausible parallel
// to Binance's -4116, matched the same way (numeric code substring, not
// full message text, per binanceAdapter's own -4116 lesson). What is NOT
// yet verified: whether Bybit actually REJECTS a duplicate orderLinkId (in
// which case this guard is correct and crash-retry stays idempotent the
// same way as Binance) or silently accepts/returns the existing order
// instead (in which case this guard never fires, and the idempotency
// story needs a different mechanism entirely). Slice C4 must confirm the
// real behavior on testnet before this can be treated as settled.
function isDuplicateClientOrderIdError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('"retCode":12141');
}

export function createBybitAdapter(client: CcxtLike): ExchangeAdapter {
  return {
    async setupSymbol(symbol, leverage, marginMode) {
      await client.loadMarkets();
      try {
        // Watch-point #1b (Sprint 4 Task C): unlike Binance's simple
        // boolean toggle, Bybit's setPositionMode maps hedged=false to
        // mode=0 (one-way) and hedged=true to mode=3 (hedge), plus
        // symbol/category params (bybit.js:7284-7317, confirmed by
        // reading source). reconcile.ts's whole fill-attribution model
        // assumes exactly one net position per symbol — if the account
        // isn't actually in one-way mode after this call, fetchPositions
        // can return two hedge legs and fetchPosition's .find() below
        // would silently grab an arbitrary one. This call site can only
        // assert that setPositionMode(false, symbol) is invoked with the
        // right arguments; it cannot prove the account actually ends up
        // in one-way mode — that requires a live hedge-to-one-way flip
        // proof on testnet (Slice C4), not a unit test.
        await client.setPositionMode(false, symbol);
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

    // Sprint 4 Task C, Slice C2b: resolved via MarketInfo's two
    // differently-shaped floors (see types.ts). Bybit's precisionMode is
    // TICK_SIZE like Binance (bybit.js:1130, confirmed), so tickSize/
    // stepSize below port unchanged. minNotional is always null here:
    // bybit.js's parseMarket hardcodes `limits.cost.min = undefined` for
    // every linear/inverse swap market (bybit.js:2237-2254) — ccxt never
    // populates a dollar-notional floor for Bybit swaps at all. The real
    // floor Bybit enforces is a CONTRACT-QUANTITY one, `limits.amount.min`
    // (Bybit's minTradingQty/minOrderQty, same source lines) — that maps
    // to minQty, checked by gridReady.ts as its own, independent
    // constraint (Slice C2 established this can't be folded into a single
    // fixed dollar minNotional across a multi-price grid).
    async getMarketInfo(symbol): Promise<MarketInfo> {
      await client.loadMarkets();
      const market = client.market(symbol);
      const tickSize = market?.precision.price;
      const stepSize = market?.precision.amount;
      const minQty = market?.limits.amount?.min;
      if (tickSize == null || stepSize == null || minQty == null) {
        throw new Error(`getMarketInfo: incomplete market info for ${symbol}`);
      }
      return { symbol, tickSize, stepSize, minNotional: null, minQty };
    },

    async fetchOHLCV(symbol, timeframe, since, limit) {
      const rows = await client.fetchOHLCV(symbol, timeframe, since, limit);
      return rows.map((row) => toCandle(row, timeframe));
    },

    async fetchPosition(symbol): Promise<Position> {
      const positions = await client.fetchPositions([symbol]);
      const position = positions.find((p) => p.symbol === symbol);
      // Watch-point #1 (confirmed, not assumed): same unsigned-magnitude
      // contract as Binance. ccxt's bybit.js parsePosition does
      // `const size = Precise.stringAbs(this.safeString2(position, 'size',
      // 'qty'))` (bybit.js:6985) before returning it as `contracts:
      // this.parseNumber(size)` (bybit.js:7081) — the same explicit abs()
      // pattern Binance's positionAmt gets, just over Bybit's own raw
      // size/qty fields. Safe for SHORT too, not just LONG.
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
        // Idempotent retry, same contract as Binance: an order with this
        // exact clientOrderId already rests on the exchange (from a
        // pre-crash attempt) — that already IS the desired state. See the
        // PROVISIONAL warning on isDuplicateClientOrderIdError above.
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

    // Bybit's cancel-by-client-id param is named `orderLinkId`, not
    // Binance's `origClientOrderId` (bybit.js's cancelOrderRequest, lines
    // 4863-4885: `// 'orderLinkId': 'string', // The user can also use
    // argument params["orderLinkId"]` — merged into the request via
    // `this.extend(request, params)`). OrderNotFound is reused unchanged:
    // bybit.js's exceptions.exact maps retCode 110001 ("Order does not
    // exist") to ccxt's own OrderNotFound class (bybit.js:707) — the same
    // unified class binanceAdapter already imports from 'ccxt', not a new
    // Bybit-specific one.
    async cancelOrder(symbol, clientOrderId) {
      try {
        await client.cancelOrder('', symbol, { orderLinkId: clientOrderId });
      } catch (error) {
        if (error instanceof OrderNotFound) {
          throw new OrderNotFoundError(
            `bybitAdapter: order ${clientOrderId} not found (already filled/cancelled)`,
          );
        }
        throw error;
      }
    },

    async cancelAll(symbol) {
      await client.cancelAllOrders(symbol);
    },

    // bybit.js declares 'fetchFundingRate': 'emulated' (line 88) — ccxt
    // emulates it through fetchFundingRates under the hood rather than a
    // native single-symbol endpoint, but the call shape and returned
    // fields are the same unified FundingRate as Binance, so no adapter
    // code needs to know about that difference.
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

    async fetchFundingHistory(symbol, since): Promise<FundingPayment[]> {
      const history = await client.fetchFundingHistory(symbol, since, 1000);
      return history.map((entry) => ({
        timestamp: entry.timestamp ?? 0,
        amount: entry.amount ?? 0,
      }));
    },
  };
}

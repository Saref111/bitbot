import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { beforeAll, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';
import { createBinanceCcxtClient } from '../../src/exchange/binanceClient.js';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import type { ExchangeAdapter } from '../../src/exchange/types.js';

const SYMBOL = 'ETH/USDT:USDT';

describe('Binance Futures testnet — full adapter cycle (MVP §11)', () => {
  let adapter: ExchangeAdapter;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    const client = createBinanceCcxtClient(credentials);
    adapter = createBinanceAdapter(client);
  });

  it('reads market info (tickSize/stepSize/minNotional)', async () => {
    const market = await adapter.getMarketInfo(SYMBOL);
    expect(market.tickSize).toBeGreaterThan(0);
    expect(market.stepSize).toBeGreaterThan(0);
    expect(market.minNotional).toBeGreaterThan(0);
  });

  it('sets up the symbol (leverage/margin/one-way) without throwing', async () => {
    await expect(adapter.setupSymbol(SYMBOL, 2, 'cross')).resolves.not.toThrow();
  });

  it('reads the current position (flat or open, must not throw)', async () => {
    const position = await adapter.fetchPosition(SYMBOL);
    expect(position.symbol).toBe(SYMBOL);
  });

  it('reads the current funding rate', async () => {
    const funding = await adapter.fetchFundingRate(SYMBOL);
    expect(typeof funding.fundingRate).toBe('number');
  });

  it('fetches recent 1m OHLCV', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 5);
    expect(candles.length).toBeGreaterThan(0);
  });

  it('places a limit order far below market, sees it in fetchOpenOrders, then cancels it', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a safe test price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    // 50% below the last close — deep enough that it will not fill during the test.
    const farPrice = Math.round((lastClose * 0.5) / market.tickSize) * market.tickSize;
    const rawAmount = market.minNotional / farPrice;
    const amount = Math.ceil(rawAmount / market.stepSize) * market.stepSize;

    const clientOrderId = `bitbot-test-${String(Date.now())}`;
    const placed = await adapter.createOrder({
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount,
      price: farPrice,
      clientOrderId,
    });
    expect(placed.clientOrderId).toBe(clientOrderId);

    const openOrders = await adapter.fetchOpenOrders(SYMBOL);
    expect(openOrders.some((order) => order.clientOrderId === clientOrderId)).toBe(true);

    // NOTE: cancels ALL open orders on SYMBOL, not just this test's order.
    await adapter.cancelAll(SYMBOL);

    const afterCancel = await adapter.fetchOpenOrders(SYMBOL);
    expect(afterCancel.some((order) => order.clientOrderId === clientOrderId)).toBe(false);
  });
});

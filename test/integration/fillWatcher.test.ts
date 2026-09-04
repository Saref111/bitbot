import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';
import {
  createBinanceCcxtClient,
  createBinanceProCcxtClient,
} from '../../src/exchange/binanceClient.js';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import { createBinanceFillWatcher } from '../../src/exchange/fillWatcher.js';
import { sleep } from '../../src/util/time.js';
import type { ExchangeAdapter, FillWatcher } from '../../src/exchange/types.js';
import { requireMinNotional } from '../helpers/fixtures.js';

const SYMBOL = 'ETH/USDT:USDT';

describe('createBinanceFillWatcher — real WS wake-up on testnet (MVP §13.5, PLAN.md Slice 11)', () => {
  let adapter: ExchangeAdapter;
  let fillWatcher: FillWatcher;
  const clientOrderId = `bitbot-test-ws-${String(Date.now())}`;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
    fillWatcher = createBinanceFillWatcher(createBinanceProCcxtClient(credentials));
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
    const position = await adapter.fetchPosition(SYMBOL);
    if (position.contracts > 0) {
      await adapter.createOrder({
        symbol: SYMBOL,
        side: position.side === 'short' ? 'buy' : 'sell',
        type: 'market',
        amount: position.contracts,
        clientOrderId: `${clientOrderId}-cleanup`,
        reduceOnly: true,
      });
    }
  });

  it('resolves promptly once a forced fill actually happens on the exchange', async () => {
    // Start watching BEFORE the fill happens — watchOrders only delivers
    // events live from when the connection/subscription is established, it
    // doesn't replay history. Confirmed via manual diagnosis: the private
    // user-data-stream needs a REST round-trip for the listenKey (~1.3s on
    // testnet) plus the WS handshake before it's actually subscribed — an
    // aggressive marketable order placed right away can fill and have its
    // executionReport pushed before that setup finishes, which looks
    // identical to "WS never fires" from the outside. A real bot's
    // fillWatcher is already live continuously before any order exists, so
    // this warm-up only compensates for this test's own artificial "start
    // watching and immediately force a fill" sequencing.
    const watchPromise = fillWatcher.next(SYMBOL);
    await sleep(3000);

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    // 2% above market: marketable, forces an immediate fill (same trick as
    // the REST-only tests).
    const price = Math.round(lastClose * 1.02 * 100) / 100;
    const amount =
      Math.ceil((requireMinNotional(market) * 1.5) / price / market.stepSize) * market.stepSize;

    await adapter.createOrder({
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount,
      price,
      clientOrderId,
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, 15_000);
    });
    const outcome = await Promise.race([watchPromise.then(() => 'resolved' as const), timeout]);

    expect(outcome).toBe('resolved');
  }, 30_000);
});

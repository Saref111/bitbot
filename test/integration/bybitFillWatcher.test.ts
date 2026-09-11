import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBybitCredentials } from '../../src/exchange/credentials.js';
import { createBybitCcxtClient, createBybitProCcxtClient } from '../../src/exchange/bybitClient.js';
import { createBybitAdapter } from '../../src/exchange/bybitAdapter.js';
import { createBinanceFillWatcher } from '../../src/exchange/fillWatcher.js';
import { sleep } from '../../src/util/time.js';
import { requireMinQty } from '../helpers/fixtures.js';
import type { ExchangeAdapter, FillWatcher } from '../../src/exchange/types.js';

const SYMBOL = 'ETH/USDT:USDT';

/**
 * Sprint 4 Task D — closes the Slice C7 gap directly and unambiguously:
 * `createBybitProCcxtClient` had never been constructed by any test
 * (Slice C4's mechanics test is REST-only, same as main.ts's own wiring
 * comment notes) — WS connect/wake on Bybit's demo stream was only
 * source-confirmed (Slice C1: pro/bybit.js's getUrlByMarketType routes to
 * stream-demo), never run. Mirrors test/integration/fillWatcher.test.ts
 * (the Binance original) exactly, swapping only the exchange — a resolved
 * watchPromise is direct proof the WS actually delivered a live order
 * update, not an inference from runDeal's internal (unexposed) wsHealth
 * flag, which is why this is a dedicated test rather than folded into the
 * SHORT×Bybit lifecycle test in bybitTestnet.test.ts.
 */
describe('createBinanceFillWatcher(createBybitProCcxtClient(...)) — real WS wake-up on Bybit demo-testnet (Sprint 4 Task D)', () => {
  let adapter: ExchangeAdapter;
  let fillWatcher: FillWatcher;
  const clientOrderId = `bitbot-test-by-ws-${String(Date.now())}`;

  beforeAll(() => {
    const credentials = loadBybitCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet Bybit account (BYBIT_TESTNET must be "true")',
      );
    }
    adapter = createBybitAdapter(createBybitCcxtClient(credentials));
    fillWatcher = createBinanceFillWatcher(createBybitProCcxtClient(credentials));
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
    // Same warm-up rationale as the Binance original: start watching
    // before forcing the fill, then give the WS subscription time to
    // actually establish before the order can fill and race it.
    const watchPromise = fillWatcher.next(SYMBOL);
    await sleep(3000);

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    // 2% above market: marketable, forces an immediate fill (same trick as
    // the REST-only Bybit tests in bybitTestnet.test.ts).
    const price = Math.round(lastClose * 1.02 * 100) / 100;
    const amount = Math.ceil((requireMinQty(market) * 1.5) / market.stepSize) * market.stepSize;

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

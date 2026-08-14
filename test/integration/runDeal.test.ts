import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';
import { createBinanceCcxtClient } from '../../src/exchange/binanceClient.js';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { runDeal } from '../../src/orchestrator/runDeal.js';
import { pollUntil } from '../../src/orchestrator/pollUntil.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';
import { buildConfig } from '../helpers/buildConfig.js';

const SYMBOL = 'ETH/USDT:USDT';

describe('createBinanceAdapter.cancelOrder — cancels by clientOrderId on testnet (Slice 9)', () => {
  let adapter: ExchangeAdapter;
  const clientOrderId = `bitbot-test-cancel-${String(Date.now())}`;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
  });

  it('places a deeply-unmarketable limit order, cancels it by clientOrderId, and it disappears from fetchOpenOrders', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    // 20% below market: never fills during the test, stays resting until
    // cancelled. Size it comfortably above minNotional (0.01 ETH tripped
    // Binance's $20 floor at current testnet prices) using the real market
    // info, the same way gridReady.ts sizes real grid rungs.
    const market = await adapter.getMarketInfo(SYMBOL);
    const price = Math.round(lastClose * 0.8 * 100) / 100;
    const amount =
      Math.ceil((market.minNotional * 1.5) / price / market.stepSize) * market.stepSize;

    await adapter.createOrder({
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount,
      price,
      clientOrderId,
    });

    const restingBeforeCancel = await pollUntil<OpenOrder>(
      async () => {
        const openOrders = await adapter.fetchOpenOrders(SYMBOL);
        return openOrders.find((order) => order.clientOrderId === clientOrderId) ?? null;
      },
      { intervalMs: 1000, timeoutMs: 10_000 },
    );
    expect(restingBeforeCancel.status).toBe('open');

    await adapter.cancelOrder(SYMBOL, clientOrderId);

    await pollUntil<true>(
      async () => {
        const openOrders = await adapter.fetchOpenOrders(SYMBOL);
        return openOrders.some((order) => order.clientOrderId === clientOrderId) ? null : true;
      },
      { intervalMs: 1000, timeoutMs: 10_000 },
    );
  });
});

describe('createBinanceAdapter.createOrder — idempotent retry on a duplicate clientOrderId (Slice 9)', () => {
  let adapter: ExchangeAdapter;
  const clientOrderId = `bitbot-test-dup-${String(Date.now())}`;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
  });

  it('resolves instead of throwing when createOrder is retried with the same clientOrderId (crash-before-DB-commit simulation)', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    const price = Math.round(lastClose * 0.8 * 100) / 100;
    const amount =
      Math.ceil((market.minNotional * 1.5) / price / market.stepSize) * market.stepSize;
    const params = {
      symbol: SYMBOL,
      side: 'buy' as const,
      type: 'limit' as const,
      amount,
      price,
      clientOrderId,
    };

    await adapter.createOrder(params);
    // Propagation into fetchOpenOrders' read path is eventually-consistent
    // on testnet — observed flaky at 10s (Node version ruled out: confirmed
    // v24.19.0 in both the passing and failing runs). Generous headroom
    // here, not a fixed exact bound.
    await pollUntil<OpenOrder>(
      async () => {
        const openOrders = await adapter.fetchOpenOrders(SYMBOL);
        return openOrders.find((order) => order.clientOrderId === clientOrderId) ?? null;
      },
      { intervalMs: 1000, timeoutMs: 25_000 },
    );

    // This is EXACTLY the retry runDeal would perform on resume after a
    // crash between createOrder succeeding and the DB write committing. If
    // the real Binance error for a duplicate clientOrderId doesn't match
    // what isDuplicateClientOrderIdError checks for, this throws and the
    // real error message/code shows up in the failure output below.
    const result = await adapter.createOrder(params);
    expect(result.clientOrderId).toBe(clientOrderId);
  });
});

describe('runDeal — external cancel of a resting grid rung leads to HALTED (MVP §11, PLAN.md Slice 9)', () => {
  let adapter: ExchangeAdapter;
  let dealId: string | undefined;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
  });

  // Rung 1 is deliberately marketable to force a real fill, so this test
  // leaves a real (tiny) position + resting orders on the testnet account —
  // clean up regardless of whether the test itself passed or failed.
  afterAll(async () => {
    if (!dealId) return;
    await adapter.cancelAll(SYMBOL);
    const position = await adapter.fetchPosition(SYMBOL);
    if (position.contracts > 0) {
      await adapter.createOrder({
        symbol: SYMBOL,
        side: position.side === 'short' ? 'buy' : 'sell',
        type: 'market',
        amount: position.contracts,
        clientOrderId: `${dealId}-cleanup`,
        reduceOnly: true,
      });
    }
  });

  it('reaches ACTIVE on a forced fill, then HALTs once a live grid rung is cancelled out from under it', async () => {
    dealId = `bitbot-test-${String(Date.now())}`;

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive entryPrice from');

    // 2% above the last close: rung 1 (depth=indent_pct off entryPrice)
    // still lands comfortably above the real ask, guaranteeing an immediate
    // fill — see thinSlice's original conversation record for why TP can't
    // be forced the same way.
    const entryPrice = lastClose * 1.02;

    const config = buildConfig({
      deposit_usdt: 50,
      leverage: 2,
      grid: {
        orders: 2,
        overlap_pct: 5,
        indent_pct: 0.2,
        martingale_pct: 0,
        log_distribution: 1,
        partial_placement: null,
        runaway_cancel_pct: 5, // wide enough that this test's timing never trips it
      },
      take_profit_pct: 0.5,
      stop_loss: null,
    });

    const db = openDatabase();

    // Cancel rung 2 (the still-pending, never-filled rung) a couple of
    // seconds after starting — enough time for rung 1's forced fill to be
    // detected and the deal to reach ACTIVE first, so this exercises a real
    // external cancel of a LIVE resting order, not a race with GRID_PLACED.
    const rung2ClientOrderId = `${dealId}-2`;
    setTimeout(() => {
      void adapter.cancelOrder(SYMBOL, rung2ClientOrderId).catch(() => {
        // Ignore — if it already got cleaned up some other way, the
        // reconcile loop's confirmation-gate is what we're actually testing.
      });
    }, 4000);

    const result = await runDeal({
      adapter,
      db,
      config,
      now: () => Date.now(),
      dealId,
      entryPrice,
      options: { pollIntervalMs: 1500, haltConfirmationTicks: 2 },
    });

    expect(result.outcome).toBe('halted');
    const deal = getDeal(db, dealId);
    expect(deal?.status).toBe('HALTED');
  }, 60_000);
});

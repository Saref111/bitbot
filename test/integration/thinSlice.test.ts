import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';
import { createBinanceCcxtClient } from '../../src/exchange/binanceClient.js';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import { openDatabase } from '../../src/storage/db.js';
import { openDeal } from '../../src/orchestrator/openDeal.js';
import { pollUntil } from '../../src/orchestrator/pollUntil.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';
import { buildConfig } from '../helpers/buildConfig.js';

const SYMBOL = 'ETH/USDT:USDT';

describe('Thin slice on testnet — open -> fill -> TP placed (MVP §5, PLAN.md Slice 7)', () => {
  let adapter: ExchangeAdapter;
  let dealId: string | undefined;

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

  // This test deliberately crosses the spread to force a real fill, so it
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

  it('places the whole grid, detects the first (forced) fill, and places a correctly-priced resting TP', async () => {
    dealId = `bitbot-test-${String(Date.now())}`;

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive entryPrice from');

    // 2% above the last close: rung 1 (depth=indent_pct off entryPrice) still
    // lands comfortably above the real ask, guaranteeing an immediate fill —
    // see the conversation record for why TP can't be forced the same way.
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
        runaway_cancel_pct: 0,
      },
      take_profit_pct: 0.5,
      stop_loss: null,
    });

    const db = openDatabase();
    const result = await openDeal({
      adapter,
      db,
      config,
      now: () => Date.now(),
      dealId,
      entryPrice,
      pollIntervalMs: 1000,
      fillTimeoutMs: 30_000,
    });

    expect(result.avgEntry).toBeGreaterThan(0);
    // The real fill price should be close to market, not the inflated entryPrice.
    expect(Math.abs(result.avgEntry - lastClose) / lastClose).toBeLessThan(0.05);
    expect(result.takeProfitPrice).toBeCloseTo(result.avgEntry * 1.005, 2);

    // A freshly-placed order can take a beat to show up in fetchOpenOrders
    // on testnet (propagation delay, not a bug) — retry briefly instead of
    // a single check.
    const tp = await pollUntil<OpenOrder>(
      async () => {
        const openOrders = await adapter.fetchOpenOrders(SYMBOL);
        return openOrders.find((order) => order.clientOrderId === result.exitClientOrderId) ?? null;
      },
      { intervalMs: 1000, timeoutMs: 10_000 },
    );
    expect(tp.side).toBe('sell');
    expect(tp.reduceOnly).toBe(true);
    expect(tp.price).toBeCloseTo(result.takeProfitPrice, 1);
  });
});

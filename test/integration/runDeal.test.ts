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
import { requireMinNotional } from '../helpers/fixtures.js';

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
      Math.ceil((requireMinNotional(market) * 1.5) / price / market.stepSize) * market.stepSize;

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
      Math.ceil((requireMinNotional(market) * 1.5) / price / market.stepSize) * market.stepSize;
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

// Sprint 4 Task B, Slice B4: SHORT mirror of the LONG "external cancel ->
// HALTED" test above — same pattern, inverted (SELL to force entry, grid
// above entry per Task A, BUY reduceOnly to close). This is the minimum
// scope for the "SHORT lifecycle runs mechanically on testnet" AC
// (docs/SPRINT_4.md Task B); the full open->grid->TP->close cycle is a
// stretch goal, not required here, since forcing a real TP fill needs
// price mechanics that would need their own empirical tuning against live
// testnet — this scenario never needs the TP to fill at all.
describe('runDeal SHORT — external cancel of a resting grid rung leads to HALTED (Sprint 4 Task B, Slice B4)', () => {
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
  // leaves a real (tiny) SHORT position + resting orders on the testnet
  // account — clean up regardless of whether the test itself passed or
  // failed. reduceOnly buy closes a short (mirrors the LONG cleanup's
  // reduceOnly sell) — the same `position.side === 'short' ? 'buy' :
  // 'sell'` branch as the LONG test's cleanup already handles this
  // correctly for either direction, unchanged here.
  afterAll(async () => {
    if (!dealId) return;
    await adapter.cancelAll(SYMBOL);
    const position = await adapter.fetchPosition(SYMBOL);
    if (position.contracts > 0) {
      await adapter.createOrder({
        symbol: SYMBOL,
        side: 'buy',
        type: 'market',
        amount: position.contracts,
        clientOrderId: `${dealId}-cleanup`,
        reduceOnly: true,
      });
    }
  });

  it('reaches ACTIVE on a forced SHORT fill, then HALTs once a live grid rung is cancelled out from under it', async () => {
    // Binance clientOrderId limit is 36 chars; the longest suffix any
    // caller appends here is "-cleanup" (8 chars) — verified against a real
    // -4015 rejection during this test's own testnet run with a longer
    // prefix ("bitbot-test-short-" + 13-digit timestamp + "-cleanup" = 39
    // chars). Keep this prefix short enough to leave headroom.
    dealId = `bitbot-s-${String(Date.now())}`;

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive entryPrice from');

    // 2% BELOW the last close (mirrors LONG's 2% above): rung 1
    // (depth=indent_pct above entryPrice for short, Task A) still lands
    // comfortably below the real bid, guaranteeing an immediate SELL fill.
    const entryPrice = lastClose * 0.98;

    const config = buildConfig({
      direction: 'short',
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

    // Sprint 4 Task A watch-point #1, closed empirically here: reconcile.ts's
    // grid/exit fill attribution assumes position.contracts is always an
    // unsigned magnitude — Task A verified this by reading ccxt's source
    // (Precise.stringAbs over Binance's raw signed positionAmt), this is
    // the first real confirmation against a live SHORT position instead of
    // ccxt's source code. Runs concurrently with runDeal below, polling
    // independently for the position to appear.
    const shortPositionObserved = pollUntil(
      async () => {
        const position = await adapter.fetchPosition(SYMBOL);
        return position.contracts > 0 ? position : null;
      },
      { intervalMs: 1000, timeoutMs: 20_000 },
    );

    const [result, observedPosition] = await Promise.all([
      runDeal({
        adapter,
        db,
        config,
        now: () => Date.now(),
        dealId,
        entryPrice,
        options: { pollIntervalMs: 1500, haltConfirmationTicks: 2 },
      }),
      shortPositionObserved,
    ]);

    console.log('[Task B watch-point #1] real SHORT adapter.fetchPosition():', observedPosition);
    expect(observedPosition.contracts).toBeGreaterThanOrEqual(0);
    expect(observedPosition.side).toBe('short');
    expect(observedPosition.entryPrice).not.toBeNull();
    expect(observedPosition.liquidationPrice).not.toBeNull();

    console.log('[Slice B4] runDeal result:', result);
    expect(result.outcome).toBe('halted');
    if (result.outcome === 'halted') {
      // Confirms the halt was triggered by the external rung cancel this
      // test itself performs (rung_cancelled), not a spurious
      // position_diverged from a size mismatch elsewhere in the flow.
      expect(result.reason).toMatch(/^rung_cancelled:/);
    }
    const deal = getDeal(db, dealId);
    expect(deal?.status).toBe('HALTED');
  }, 60_000);
});

describe('createBinanceAdapter.fetchTrades/fetchFundingHistory — real shape on testnet (Slice 10: NET)', () => {
  let adapter: ExchangeAdapter;
  const clientOrderId = `bitbot-test-net-${String(Date.now())}`;

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

  it('reports fee.currency and takerOrMaker computeNet.ts actually relies on, for a real forced fill', async () => {
    const since = Date.now();
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    // 2% above market: marketable, forces an immediate fill (same trick as
    // the external-cancel test above).
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

    const filledPosition = await pollUntil(
      async () => {
        const position = await adapter.fetchPosition(SYMBOL);
        return position.contracts > 0 ? position : null;
      },
      { intervalMs: 1000, timeoutMs: 15_000 },
    );

    // Close it right back out via a market reduceOnly sell — keeps this
    // test's footprint on the account minimal and gives a SECOND real trade
    // (a taker fill) to inspect alongside the entry.
    await adapter.createOrder({
      symbol: SYMBOL,
      side: 'sell',
      type: 'market',
      amount: filledPosition.contracts,
      clientOrderId: `${clientOrderId}-close`,
      reduceOnly: true,
    });

    const trades = await pollUntil(
      async () => {
        const observed = await adapter.fetchTrades(SYMBOL, since);
        return observed.length >= 2 ? observed : null;
      },
      { intervalMs: 1000, timeoutMs: 15_000 },
    );

    for (const trade of trades) {
      // computeNet.ts's currency guard assumes fees land in the quote
      // currency on a normal (non-BNB-discount) account — confirm that
      // holds for real here, not just in the mocked unit tests.
      expect(trade.feeCurrency).toBe('USDT');
      expect(['maker', 'taker']).toContain(trade.takerOrMaker);
    }

    // No funding will have accrued in the few seconds this test runs —
    // this only proves the call succeeds and returns an array shape
    // computeNet.ts can sum, not a specific value.
    const funding = await adapter.fetchFundingHistory(SYMBOL, since);
    expect(Array.isArray(funding)).toBe(true);
  }, 60_000);
});

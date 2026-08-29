import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';
import { createBinanceCcxtClient } from '../../src/exchange/binanceClient.js';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import { openDatabase } from '../../src/storage/db.js';
import {
  insertDeal,
  updateDeal,
  insertGridOrders,
  updateGridOrderStatus,
  getGridOrdersByDeal,
  getExitOrdersByDeal,
} from '../../src/storage/index.js';
import { recoverDeal } from '../../src/orchestrator/recoverDeal.js';
import { pollUntil } from '../../src/orchestrator/pollUntil.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';

const SYMBOL = 'ETH/USDT:USDT';

/**
 * Sprint 3 Task G: reconcileOrphans (src/orchestrator/recoverDeal.ts) has
 * never been exercised against REAL testnet state before — the existing
 * test/orchestrator/recoverDeal.test.ts mocks the exchange adapter
 * entirely. These two scenarios reproduce the exact two crash-windows
 * that function's own doc comment names, using real resting orders on
 * Binance testnet. A third window it names (a rung created AND fully
 * filled-and-gone within the same downtime) is deliberately NOT
 * reproduced here — fetchOpenOrders only shows currently-resting orders,
 * so this can't be exercised directly; that window's safety net is
 * reconcileTick's own leftover-budget check (position_diverged -> HALT),
 * already covered by the external-cancel HALT test in runDeal.test.ts.
 */
describe('recoverDeal — reconcileOrphans against real testnet state (Sprint 3 Task G)', () => {
  let adapter: ExchangeAdapter;

  beforeAll(() => {
    const credentials = loadExchangeCredentials();
    if (!credentials.testnet) {
      throw new Error(
        'Refusing to run integration tests against a non-testnet account (BINANCE_TESTNET must be "true")',
      );
    }
    adapter = createBinanceAdapter(createBinanceCcxtClient(credentials));
  });

  describe('scenario A: a pending grid rung is promoted to placed when found resting live (no real fill needed)', () => {
    // Kept short: Binance rejects clientOrderId over 36 chars, and this
    // gets suffixed further ("-1", "-cleanup").
    const dealId = `btg-a-${String(Date.now())}`;
    const clientOrderId = `${dealId}-1`;

    afterAll(async () => {
      await adapter.cancelAll(SYMBOL);
    });

    it('promotes the pending row without re-submitting the order', async () => {
      const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
      const lastClose = candles.at(-1)?.close;
      if (lastClose === undefined) throw new Error('no candle to derive a price from');

      // Deep below market: a BUY resting order, never fills during the
      // test — this scenario needs no real position at all.
      const market = await adapter.getMarketInfo(SYMBOL);
      const price = Math.round((lastClose * 0.5) / market.tickSize) * market.tickSize;
      const amount = Math.ceil((market.minNotional * 1.5) / price / market.stepSize) * market.stepSize;

      const db = openDatabase();
      const config = buildConfig({ grid: { orders: 2, overlap_pct: 5, indent_pct: 0.2 } });

      insertDeal(db, { id: dealId, status: 'GRID_PLACED', direction: 'long', depositUsdt: 50, openedAt: Date.now() });
      updateDeal(db, dealId, { pEntry: lastClose });
      // insertGridOrders always inserts as 'pending' — exactly the
      // crash-window state reconcileOrphans' own comment describes
      // (createOrder succeeded, the DB write marking it 'placed' didn't).
      insertGridOrders(db, dealId, [{ rungIndex: 1, price, size: amount, clientOrderId }], Date.now());

      // Really place the order the DB row above claims is only 'pending'.
      await adapter.createOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', amount, price, clientOrderId });
      await pollUntil<OpenOrder>(
        async () => {
          const openOrders = await adapter.fetchOpenOrders(SYMBOL);
          return openOrders.find((order) => order.clientOrderId === clientOrderId) ?? null;
        },
        { intervalMs: 1000, timeoutMs: 25_000 },
      );

      // reconcileOrphans always runs unconditionally before runDealLoop's
      // own signal check — an already-aborted signal lets the loop return
      // 'shutdown' immediately after the orphan check, with no need to
      // wait for a real tick.
      const controller = new AbortController();
      controller.abort();
      const result = await recoverDeal({
        adapter,
        db,
        config,
        now: () => Date.now(),
        dealId,
        options: { signal: controller.signal },
      });

      expect(result.outcome).toBe('shutdown');
      const gridOrders = getGridOrdersByDeal(db, dealId);
      expect(gridOrders.find((o) => o.clientOrderId === clientOrderId)).toMatchObject({
        status: 'placed',
        filledSize: 0,
      });
    }, 40_000);
  });

  describe('scenario B: an orphaned TP order (no exit_order row) is adopted (needs a real forced fill)', () => {
    // Kept short: Binance rejects clientOrderId over 36 chars, and this
    // gets suffixed further ("-1", "-tp-0", "-cleanup").
    const dealId = `btg-b-${String(Date.now())}`;
    const rung1ClientOrderId = `${dealId}-1`;
    const tpClientOrderId = `${dealId}-tp-0`; // 0-based, mirrors real exitTargets.ts naming

    afterAll(async () => {
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

    it('reconstructs the exit_order row from the live order', async () => {
      const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
      const lastClose = candles.at(-1)?.close;
      if (lastClose === undefined) throw new Error('no candle to derive a price from');

      const market = await adapter.getMarketInfo(SYMBOL);
      // 2% above market: marketable BUY, forces an immediate real fill ->
      // a real LONG position (same trick as runDeal.test.ts).
      const fillPrice = Math.round(lastClose * 1.02 * 100) / 100;
      const amount =
        Math.ceil((market.minNotional * 1.5) / fillPrice / market.stepSize) * market.stepSize;

      await adapter.createOrder({
        symbol: SYMBOL,
        side: 'buy',
        type: 'limit',
        amount,
        price: fillPrice,
        clientOrderId: rung1ClientOrderId,
      });
      // Wait for the fill to actually land in fetchPosition, not just
      // assume it happened the instant createOrder resolved — placing a
      // reduceOnly TP against a not-yet-visible position would get
      // rejected by testnet as "reduceOnly with no position", which would
      // be a setup race, not the recovery bug this test is actually about.
      const filledPosition = await pollUntil(
        async () => {
          const position = await adapter.fetchPosition(SYMBOL);
          return position.contracts > 0 ? position : null;
        },
        { intervalMs: 1000, timeoutMs: 20_000 },
      );

      const db = openDatabase();
      const config = buildConfig({ grid: { orders: 2, overlap_pct: 5, indent_pct: 0.2 } });

      insertDeal(db, { id: dealId, status: 'ACTIVE', direction: 'long', depositUsdt: 50, openedAt: Date.now() });
      updateDeal(db, dealId, { pEntry: fillPrice, filledRungsCount: 1 });
      insertGridOrders(
        db,
        dealId,
        [{ rungIndex: 1, price: fillPrice, size: filledPosition.contracts, clientOrderId: rung1ClientOrderId }],
        Date.now(),
      );
      updateGridOrderStatus(db, rung1ClientOrderId, {
        status: 'filled',
        filledAt: Date.now(),
        fillPrice,
      });
      // Deliberately NO insertExitOrder — simulates a crash between the
      // TP's createOrder succeeding and the transaction that would have
      // recorded it.

      // TP on a LONG is a SELL — the direction this scenario must NOT
      // mirror from scenario A's "far below": to REST (not fill
      // immediately, which would leave nothing for reconcileOrphans to
      // find), a sell must sit well ABOVE market, not below.
      const tpPrice = Math.round((lastClose * 1.5) / market.tickSize) * market.tickSize;
      await adapter.createOrder({
        symbol: SYMBOL,
        side: 'sell',
        type: 'limit',
        amount: filledPosition.contracts,
        price: tpPrice,
        clientOrderId: tpClientOrderId,
        reduceOnly: true,
      });
      // Generous headroom, not a tight bound — testnet's fetchOpenOrders
      // propagation is eventually-consistent and observably slower under
      // account load (same caveat runDeal.test.ts's own idempotency test
      // documents; this test flaked at 25s once when run right after that
      // suite's own heavy real-trading activity, passed reliably at ~3s
      // in isolation).
      await pollUntil<OpenOrder>(
        async () => {
          const openOrders = await adapter.fetchOpenOrders(SYMBOL);
          return openOrders.find((order) => order.clientOrderId === tpClientOrderId) ?? null;
        },
        { intervalMs: 1000, timeoutMs: 45_000 },
      );

      const controller = new AbortController();
      controller.abort();
      const result = await recoverDeal({
        adapter,
        db,
        config,
        now: () => Date.now(),
        dealId,
        options: { signal: controller.signal },
      });

      expect(result.outcome).toBe('shutdown');
      const exitOrders = getExitOrdersByDeal(db, dealId);
      const adopted = exitOrders.find((o) => o.clientOrderId === tpClientOrderId);
      expect(adopted).toMatchObject({ type: 'tp', price: tpPrice, amount: filledPosition.contracts });
    }, 90_000);
  });
});

import { config as loadDotenv } from 'dotenv';

loadDotenv();

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NoChange } from 'ccxt';
import { buildOrchestratorContext } from '../../src/main.js';
import { createBybitCcxtClient, loadBybitCredentials } from '../../src/exchange/index.js';
import { openDatabase } from '../../src/storage/db.js';
import { getDeal } from '../../src/storage/dealRepository.js';
import { runDeal } from '../../src/orchestrator/runDeal.js';
import { pollUntil } from '../../src/orchestrator/pollUntil.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { requireMinQty } from '../helpers/fixtures.js';
import type { ExchangeAdapter, FillWatcher, MarketInfo, OpenOrder } from '../../src/exchange/types.js';

const SYMBOL = 'ETH/USDT:USDT';
const BYBIT_CONFIG_PATH = new URL('../fixtures/config/bybit-testnet.yaml', import.meta.url).pathname;

/**
 * Sprint 4 Task C, Slice C4: unlike every Binance integration test (which
 * constructs createBinanceAdapter directly, the B4 precedent), the adapter
 * here MUST come from buildOrchestratorContext(...) with a real config file
 * whose exchange: 'bybit-futures' — not a direct createBybitAdapter(...)
 * call. Slice C3's review found main.ts's switch(config.exchange) branch
 * has no unit test and type-checks fine even with swapped case bodies
 * (both branches return ExchangeAdapter/ExchangeCredentials) — constructing
 * the adapter directly here would leave that branch completely unexercised
 * until a real prod run against Bybit. This is that one real exercise.
 */
function buildBybitTestAdapter(): ExchangeAdapter {
  const { ctx, network } = buildOrchestratorContext(BYBIT_CONFIG_PATH, ':memory:');
  if (network !== 'testnet') {
    throw new Error(
      'Refusing to run integration tests against a non-testnet Bybit account (BYBIT_TESTNET must be "true")',
    );
  }
  return ctx.adapter;
}

// ccxt types client.urls loosely (effectively `any`) — narrow it for real
// here instead of asserting past it, so the precondition check below is
// actually type-safe, not just silenced.
function extractApiUrls(urls: unknown): string[] {
  if (typeof urls !== 'object' || urls === null) {
    throw new Error("unexpected client.urls['api'] shape: not an object");
  }
  return Object.values(urls as Record<string, unknown>).map((value) => {
    if (typeof value !== 'string') {
      throw new Error("unexpected client.urls['api'] shape: non-string entry");
    }
    return value;
  });
}

let precheckAdapter: ExchangeAdapter;

beforeAll(async () => {
  // Precondition 1 (Slice C4 review requirement): confirm the REST client
  // actually points at Bybit's demo-trading environment, not mainnet,
  // before anything below places a single real order.
  const credentials = loadBybitCredentials();
  if (!credentials.testnet) {
    throw new Error('Refusing: BYBIT_TESTNET must be "true" in .env for this suite.');
  }
  const rawClient = createBybitCcxtClient(credentials);
  console.log("[Slice C4 precondition] client.urls['api']:", rawClient.urls['api']);
  const apiUrls = extractApiUrls(rawClient.urls['api']);
  for (const url of apiUrls) {
    if (!url.includes('api-demo.') || url.startsWith('https://api.bybit.com')) {
      throw new Error(
        `Refusing: client.urls['api'] entry "${url}" does not look like Bybit's demo-trading host — aborting before any order is placed.`,
      );
    }
  }

  // Precondition 2: the account must be flat (Slice C4 review requirement,
  // and a precondition watch-point #1b's own hedge->one-way proof needs
  // anyway) — a dirty leftover from a previous run would corrupt every
  // scenario below, not just fail loudly in one place.
  precheckAdapter = buildBybitTestAdapter();
  const openOrders = await precheckAdapter.fetchOpenOrders(SYMBOL);
  if (openOrders.length > 0) {
    throw new Error(
      `Refusing to run: ${String(openOrders.length)} open order(s) already resting on the Bybit demo account for ${SYMBOL} — clean up manually first (orders: ${openOrders.map((o) => o.clientOrderId).join(', ')}).`,
    );
  }
  const position = await precheckAdapter.fetchPosition(SYMBOL);
  if (position.contracts > 0) {
    throw new Error(
      `Refusing to run: an open Bybit demo position already exists for ${SYMBOL} (contracts=${String(position.contracts)}, side=${String(position.side)}) — clean up manually first.`,
    );
  }
  console.log('[Slice C4 precondition] account confirmed flat: no open orders, no open position.');
}, 30_000);

describe('createBybitAdapter.cancelOrder — cancels by orderLinkId on demo-testnet (mirrors runDeal.test.ts Slice 9)', () => {
  let adapter: ExchangeAdapter;
  const clientOrderId = `bitbot-by-cxl-${String(Date.now())}`;

  beforeAll(() => {
    adapter = buildBybitTestAdapter();
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
  });

  it('places a deeply-unmarketable limit order, cancels it by clientOrderId, and it disappears from fetchOpenOrders', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    const price = Math.round((lastClose * 0.8) / market.tickSize) * market.tickSize;
    const amount = Math.ceil((requireMinQty(market) * 1.5) / market.stepSize) * market.stepSize;

    await adapter.createOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', amount, price, clientOrderId });

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

describe('createBybitAdapter.createOrder — duplicate orderLinkId behavioral contract (Slice C4: confirms or corrects the provisional retCode 12141 guard from Slice C2)', () => {
  let adapter: ExchangeAdapter;
  const clientOrderId = `bitbot-by-dup-${String(Date.now())}`;

  beforeAll(() => {
    adapter = buildBybitTestAdapter();
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
  });

  it('resolves instead of throwing when createOrder is retried with the same orderLinkId (crash-before-DB-commit simulation) — and does NOT create a second real order', async () => {
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');

    const market = await adapter.getMarketInfo(SYMBOL);
    const price = Math.round((lastClose * 0.8) / market.tickSize) * market.tickSize;
    const amount = Math.ceil((requireMinQty(market) * 1.5) / market.stepSize) * market.stepSize;
    const params = { symbol: SYMBOL, side: 'buy' as const, type: 'limit' as const, amount, price, clientOrderId };

    await adapter.createOrder(params);
    await pollUntil<OpenOrder>(
      async () => {
        const openOrders = await adapter.fetchOpenOrders(SYMBOL);
        return openOrders.find((order) => order.clientOrderId === clientOrderId) ?? null;
      },
      { intervalMs: 1000, timeoutMs: 25_000 },
    );

    // This is EXACTLY the retry runDeal would perform on resume after a
    // crash between createOrder succeeding and the DB write committing. If
    // the real Bybit retCode for a duplicate orderLinkId doesn't match what
    // isDuplicateClientOrderIdError checks for (retCode 12141, provisional
    // from Slice C2's ccxt-source reading, never confirmed live), this
    // throws and the real error message/retCode shows up in the failure
    // output below — that failure IS the empirical answer, not a bug to
    // silently work around.
    const result = await adapter.createOrder(params);
    expect(result.clientOrderId).toBe(clientOrderId);

    // Behavioral risk flagged in the Slice C2 plan review: even if the call
    // above resolves without throwing, Bybit might have silently accepted
    // the retry as a SECOND real order rather than rejecting/returning the
    // existing one — confirm there is still exactly ONE resting order with
    // this clientOrderId, not two.
    const openOrdersAfterRetry = await adapter.fetchOpenOrders(SYMBOL);
    const matching = openOrdersAfterRetry.filter((o) => o.clientOrderId === clientOrderId);
    expect(matching).toHaveLength(1);
  });
});

describe('watch-point #3 — orderLinkId length limit on demo-testnet (ccxt docs claim 36 chars, not verified live)', () => {
  let adapter: ExchangeAdapter;
  let market: MarketInfo;
  let price: number;
  let amount: number;

  beforeAll(async () => {
    adapter = buildBybitTestAdapter();
    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive a price from');
    market = await adapter.getMarketInfo(SYMBOL);
    price = Math.round((lastClose * 0.8) / market.tickSize) * market.tickSize;
    amount = Math.ceil((requireMinQty(market) * 1.5) / market.stepSize) * market.stepSize;
  });

  afterAll(async () => {
    await adapter.cancelAll(SYMBOL);
  });

  it('accepts a 36-char orderLinkId (ccxt-documented limit)', async () => {
    const id36 = `bitbot-by-len36-${'x'.repeat(36 - 'bitbot-by-len36-'.length)}`;
    expect(id36).toHaveLength(36);

    const result = await adapter.createOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', amount, price, clientOrderId: id36 });
    expect(result.clientOrderId).toBe(id36);
  });

  it('reports the REAL response to a 37-char orderLinkId — not assumed from the ccxt doc-comment', async () => {
    const id37 = `bitbot-by-len37-${'x'.repeat(37 - 'bitbot-by-len37-'.length)}`;
    expect(id37).toHaveLength(37);

    try {
      const result = await adapter.createOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', amount, price, clientOrderId: id37 });
      console.log('[watch-point #3] 37-char orderLinkId ACCEPTED by Bybit:', result);
      expect(result.clientOrderId).toBe(id37);
    } catch (error) {
      console.log('[watch-point #3] 37-char orderLinkId REJECTED by Bybit:', error);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('watch-point #1b — one-way position mode: hedge->setup->one-way causal proof (not a passive observation)', () => {
  let adapter: ExchangeAdapter;
  let rawClient: ReturnType<typeof createBybitCcxtClient>;

  beforeAll(async () => {
    adapter = buildBybitTestAdapter();
    rawClient = createBybitCcxtClient(loadBybitCredentials());
    await rawClient.loadMarkets();
  });

  afterAll(async () => {
    // Always leave the account in one-way mode for every later describe in
    // this file, regardless of whether the test body below passed.
    try {
      await rawClient.setPositionMode(false, SYMBOL);
    } catch (error) {
      if (!(error instanceof NoChange)) throw error;
    }
  });

  async function isNoChangePositionMode(hedged: boolean): Promise<boolean> {
    try {
      await rawClient.setPositionMode(hedged, SYMBOL);
      return false; // succeeded as a genuine change
    } catch (error) {
      if (error instanceof NoChange) return true;
      throw error;
    }
  }

  it('setupSymbol\'s setPositionMode(false) genuinely flips a forced-hedge account back to one-way, not observed by accident', async () => {
    // Step 1: force hedge mode directly on this (flat, confirmed by the
    // file-level precondition) account — expected to be a REAL change,
    // since a fresh demo account defaults to one-way.
    const hedgeWasNoChange = await isNoChangePositionMode(true);
    console.log('[watch-point #1b] forcing hedge mode — was already hedge (NoChange)?', hedgeWasNoChange);

    // Step 2: confirm we are NOW really in hedge mode — asking for hedge
    // again, directly, MUST be a no-op this time.
    const stillHedge = await isNoChangePositionMode(true);
    expect(stillHedge).toBe(true);

    // Step 3: the real subject under test — setupSymbol, via the
    // buildOrchestratorContext-sourced adapter (not a direct
    // createBybitAdapter construction), calls setPositionMode(false,
    // SYMBOL) as part of its normal sequence.
    await adapter.setupSymbol(SYMBOL, 2, 'cross');

    // Step 4: causal proof. If setupSymbol's call REALLY flipped
    // hedge -> one-way, asking for HEDGE again right now must be a genuine
    // change (NOT NoChange) — proving one-way was truly reached in
    // between, not just a state the account happened to already be in.
    const hedgeAfterSetup = await isNoChangePositionMode(true);
    expect(hedgeAfterSetup).toBe(false);
  }, 30_000);
});

describe('runDeal (Bybit) — external cancel of a resting grid rung leads to HALTED (Task G mechanics; watch-point #1 confirmed on a real fill)', () => {
  let adapter: ExchangeAdapter;
  let dealId: string | undefined;

  beforeAll(() => {
    adapter = buildBybitTestAdapter();
  });

  // Rung 1 is deliberately marketable to force a real fill, so this test
  // leaves a real (tiny) position + resting orders on the demo account —
  // clean up regardless of whether the test itself passed or failed.
  // Direction is HARDCODED ('sell' to close a LONG) rather than derived
  // from position.side — the exact B4 lesson: side is what this test is
  // itself partly validating, so the cleanup must not depend on it.
  afterAll(async () => {
    if (!dealId) return;
    await adapter.cancelAll(SYMBOL);
    const position = await adapter.fetchPosition(SYMBOL);
    if (position.contracts > 0) {
      await adapter.createOrder({
        symbol: SYMBOL,
        side: 'sell',
        type: 'market',
        amount: position.contracts,
        clientOrderId: `${dealId}-cleanup`,
        reduceOnly: true,
      });
    }
  });

  it('reaches ACTIVE on a forced fill, then HALTs once a live grid rung is cancelled out from under it', async () => {
    dealId = `bitbot-by-${String(Date.now())}`;

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive entryPrice from');

    // 2% above the last close: rung 1 still lands comfortably above the
    // real ask, guaranteeing an immediate fill (mirrors the Binance/SHORT
    // B4 pattern).
    const entryPrice = lastClose * 1.02;

    const config = buildConfig({
      exchange: 'bybit-futures',
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

    const rung2ClientOrderId = `${dealId}-2`;
    setTimeout(() => {
      void adapter.cancelOrder(SYMBOL, rung2ClientOrderId).catch(() => {
        // Ignore — if it already got cleaned up some other way, the
        // reconcile loop's confirmation-gate is what we're actually testing.
      });
    }, 4000);

    // Watch-point #1: unsigned-magnitude confirmation on a REAL Bybit
    // position (not just ccxt source reading, Slice C2's own confirmation).
    // Runs concurrently with runDeal below, polling independently.
    const longPositionObserved = pollUntil(
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
      longPositionObserved,
    ]);

    console.log('[watch-point #1] real Bybit adapter.fetchPosition():', observedPosition);
    expect(observedPosition.contracts).toBeGreaterThanOrEqual(0);
    expect(observedPosition.side).toBe('long');
    expect(observedPosition.entryPrice).not.toBeNull();
    // NOT asserted non-null, unlike the Binance/SHORT-B4 mirror test:
    // confirmed on this real run that Bybit legitimately returns
    // liquidationPrice: null for a tiny cross-margin position. ccxt's
    // bybit.js:7025 does `this.omitZero(this.safeString(position,
    // 'liqPrice'))` — its own source comments (bybit.js:6879, 9791, 9842)
    // show real Bybit V5 responses with `"liqPrice":""` for exactly this
    // kind of position, which omitZero maps to undefined/null. A genuine
    // Binance/Bybit seam (Binance's SHORT-B4 run always got a real
    // number), not a bybitAdapter.ts bug — the adapter is a faithful
    // passthrough of whatever ccxt parses.

    console.log('[Slice C4] runDeal result:', result);
    expect(result.outcome).toBe('halted');
    if (result.outcome === 'halted') {
      // Confirms the halt came from the external rung cancel this test
      // itself performs (rung_cancelled), not a spurious position_diverged
      // — same confirmation Task B Slice B4 made for the SHORT/Binance path.
      expect(result.reason).toMatch(/^rung_cancelled:/);
    }
    const deal = getDeal(db, dealId);
    expect(deal?.status).toBe('HALTED');
  }, 60_000);
});

describe('runDeal SHORT×Bybit — through the real WS fill-watcher (Sprint 4 Task D, the sprint\'s integration keystone)', () => {
  let adapter: ExchangeAdapter;
  let fillWatcher: FillWatcher;
  let dealId: string | undefined;

  // Unlike buildBybitTestAdapter() (discards the fillWatcher half of
  // buildOrchestratorContext's return) — this test needs BOTH: the exact
  // same real construction path main.ts uses for a live Bybit run,
  // including `createBybitProCcxtClient` (the Slice C7 gap). The dedicated
  // bybitFillWatcher.test.ts proves the WS itself wakes on a fill in
  // isolation (a resolved promise, unambiguous); this test proves the
  // SHORT deal-machine behaves correctly when wired to that same real
  // watcher end-to-end, mirroring Task B Slice B4 (SHORT/Binance) and this
  // file's own LONG×Bybit test above, combined on the one axis neither
  // covered alone.
  beforeAll(() => {
    const { ctx, fillWatcher: fw, network } = buildOrchestratorContext(BYBIT_CONFIG_PATH, ':memory:');
    if (network !== 'testnet') {
      throw new Error(
        'Refusing to run integration tests against a non-testnet Bybit account (BYBIT_TESTNET must be "true")',
      );
    }
    adapter = ctx.adapter;
    fillWatcher = fw;
  });

  // Rung 1 is deliberately marketable to force a real fill, so this test
  // leaves a real (tiny) SHORT position + resting orders on the demo
  // account — clean up regardless of pass/fail. Direction hardcoded
  // ('buy' closes a short), same B4 lesson as the Binance/SHORT test:
  // cleanup must not depend on position.side when side is partly what's
  // under test.
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
    dealId = `bitbot-bys-${String(Date.now())}`;

    const candles = await adapter.fetchOHLCV(SYMBOL, '1m', undefined, 1);
    const lastClose = candles.at(-1)?.close;
    if (lastClose === undefined) throw new Error('no candle to derive entryPrice from');

    // 2% below last close (mirrors the Binance/SHORT-B4 pattern): rung 1
    // still lands comfortably above the real bid for a SHORT sell, forcing
    // an immediate fill.
    const entryPrice = lastClose * 0.98;

    const config = buildConfig({
      direction: 'short',
      exchange: 'bybit-futures',
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

    const rung2ClientOrderId = `${dealId}-2`;
    setTimeout(() => {
      void adapter.cancelOrder(SYMBOL, rung2ClientOrderId).catch(() => {
        // Ignore — if it already got cleaned up some other way, the
        // reconcile loop's confirmation-gate is what we're actually testing.
      });
    }, 4000);

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
        options: { pollIntervalMs: 1500, haltConfirmationTicks: 2, fillWatcher },
      }),
      shortPositionObserved,
    ]);

    console.log('[Task D] real SHORT×Bybit adapter.fetchPosition():', observedPosition);
    expect(observedPosition.contracts).toBeGreaterThanOrEqual(0);
    expect(observedPosition.side).toBe('short');

    console.log('[Task D] runDeal result:', result);
    expect(result.outcome).toBe('halted');
    if (result.outcome === 'halted') {
      // Same confirmation as every other rung-cancel HALT test in this
      // file: the halt came from THIS test's own external cancel
      // (rung_cancelled), not a spurious position_diverged.
      expect(result.reason).toMatch(/^rung_cancelled:/);
    }
    const deal = getDeal(db, dealId);
    expect(deal?.status).toBe('HALTED');
  }, 60_000);
});

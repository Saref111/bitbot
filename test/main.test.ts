import { describe, expect, it, vi } from 'vitest';
import { runBot } from '../src/main.js';
import { openDatabase } from '../src/storage/db.js';
import { getDeal, insertDeal, updateDeal } from '../src/storage/dealRepository.js';
import {
  getGridOrdersByDeal,
  insertGridOrders,
  updateGridOrderStatus,
} from '../src/storage/gridOrderRepository.js';
import { getExitOrdersByDeal } from '../src/storage/exitOrderRepository.js';
import { candle, defaultMarket as market, position, twoRungConfig } from './helpers/fixtures.js';
import type { ExchangeAdapter, OpenOrder } from '../src/exchange/types.js';

function order(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: 'ex-1',
    clientOrderId: 'deal-1-1',
    side: 'buy',
    price: 1996,
    amount: 0.15,
    filled: 0,
    status: 'open',
    reduceOnly: false,
    ...overrides,
  };
}

// Not the entry-watching candle() fixture — a plain reading for
// gridPlacedTick's own runaway-check call, which doesn't go through
// watchForEntry's openTime dedup at all.
function priceReading(close: number) {
  return { openTime: 0, closeTime: 0, open: close, high: close, low: close, close };
}

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchPosition: vi.fn().mockResolvedValue(position()),
    createOrder: vi.fn().mockImplementation((params: { clientOrderId: string }) =>
      Promise.resolve({
        id: `ex-${params.clientOrderId}`,
        clientOrderId: params.clientOrderId,
        status: 'open',
      }),
    ),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    fetchFundingRate: vi.fn(),
    fetchTrades: vi.fn().mockResolvedValue([]),
    fetchFundingHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('runBot — a closed deal starts the next one (new dealId)', () => {
  it('drives deal 1 to a runaway-close, then begins waiting for deal 2 with a fresh id', async () => {
    const db = openDatabase();
    const config = twoRungConfig({ entry_filters: [] }); // empty filters -> entry fires on the first genuinely new candle
    const controller = new AbortController();

    const warmup = candle(0, 2000);
    const liveEntry = candle(1, 2000); // distinct openTime from warmup -> not deduped, fires entry at price 2000
    // Past runaway_cancel_pct=0.5% from pEntry=2000 (threshold 2010).
    const runawayReading = [priceReading(2020)];

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce([warmup]) // deal 1: watchForEntry warm-up
      .mockResolvedValueOnce([liveEntry]) // deal 1: watchForEntry first live poll -> fires at 2000
      .mockResolvedValueOnce(runawayReading) // deal 1: gridPlacedTick's runaway-check read
      .mockResolvedValue([warmup]); // deal 2: watchForEntry warm-up (never gets further — aborted first)

    const adapter = makeMockAdapter({
      fetchOHLCV,
      fetchOpenOrders: vi.fn().mockResolvedValue([order(), order({ clientOrderId: 'deal-1-2' })]), // both rungs still resting, untouched
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0 })), // stays flat -> runaway path
    });

    let calls = 0;
    const generateDealId = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 2) controller.abort(); // deal 2 about to start — stop right there
      return `deal-${String(calls)}`;
    });

    let t = liveEntry.closeTime;
    await runBot(
      { adapter, db, config, now: () => t++ },
      { signal: controller.signal, generateDealId },
    );

    expect(generateDealId).toHaveBeenCalledTimes(2);
    const deal1 = getDeal(db, 'deal-1');
    expect(deal1?.status).toBe('SETTLING');
    expect(deal1?.closeReason).toBe('runaway');
    // deal 2 never got far enough to be inserted — aborted during watchForEntry's warm-up.
    expect(getDeal(db, 'deal-2')).toBeNull();
  });
});

describe('runBot — an in-flight deal at startup goes to recoverDeal, not a new entry', () => {
  it('resumes the seeded GRID_PLACED deal instead of calling watchForEntry first', async () => {
    const db = openDatabase();
    const config = twoRungConfig({ entry_filters: [] });

    insertDeal(db, {
      id: 'existing-deal',
      status: 'GRID_PLACED',
      direction: 'long',
      depositUsdt: 200,
      openedAt: 900,
    });
    updateDeal(db, 'existing-deal', { pEntry: 2000 });
    insertGridOrders(
      db,
      'existing-deal',
      [{ rungIndex: 1, price: 1996, size: 0.15, clientOrderId: 'existing-deal-1' }],
      900,
    );
    updateGridOrderStatus(db, 'existing-deal-1', { status: 'placed', placedAt: 900 });

    const controller = new AbortController();
    const fetchOHLCV = vi.fn().mockResolvedValue([priceReading(2020)]); // past the runaway threshold

    const adapter = makeMockAdapter({
      fetchOHLCV,
      fetchOpenOrders: vi.fn().mockResolvedValue([order({ clientOrderId: 'existing-deal-1' })]), // still resting, untouched — used by both reconcileOrphans and the tick
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0 })),
    });

    const generateDealId = vi.fn().mockImplementation(() => {
      controller.abort(); // first fresh-deal id after recovery — stop there
      return 'deal-fresh';
    });

    await runBot(
      { adapter, db, config, now: () => 1000 },
      { signal: controller.signal, generateDealId },
    );

    const recovered = getDeal(db, 'existing-deal');
    expect(recovered?.status).toBe('SETTLING');
    expect(recovered?.closeReason).toBe('runaway');
    // dealId generation only happened for the NEXT deal, after recovery finished.
    expect(generateDealId).toHaveBeenCalledTimes(1);
  });
});

describe('runBot — include_existing_position adopts instead of waiting for entry', () => {
  it('adopts the open exchange position and never calls fetchOHLCV (no entry search)', async () => {
    const db = openDatabase();
    const config = twoRungConfig({ include_existing_position: true, entry_filters: [] });
    const controller = new AbortController();
    controller.abort(); // aborted up front — runDealLoop inside adopt should shut down on tick 1

    const fetchOHLCV = vi.fn();
    const fetchOpenOrders = vi.fn();
    const adapter = makeMockAdapter({
      fetchOHLCV,
      fetchOpenOrders,
      fetchPosition: vi
        .fn()
        .mockResolvedValue(position({ contracts: 0.05, entryPrice: 2000, liquidationPrice: 1000 })),
    });

    const generateDealId = vi.fn().mockReturnValue('deal-adopted');

    await runBot(
      { adapter, db, config, now: () => 1000 },
      { signal: controller.signal, generateDealId },
    );

    expect(generateDealId).toHaveBeenCalledTimes(1);
    const gridOrders = getGridOrdersByDeal(db, 'deal-adopted');
    expect(gridOrders).toHaveLength(1);
    expect(gridOrders[0]).toMatchObject({ status: 'filled', fillPrice: 2000 });
    const exitOrders = getExitOrdersByDeal(db, 'deal-adopted');
    expect(exitOrders[0]).toMatchObject({ clientOrderId: 'deal-adopted-tp-0' });

    expect(fetchOpenOrders).not.toHaveBeenCalled(); // shut down before the first ACTIVE tick
    expect(fetchOHLCV).not.toHaveBeenCalled(); // no entry search ever ran
  });
});

describe('runBot — halted stops the loop, no next deal is attempted', () => {
  it('does not call generateDealId a second time after a halt', async () => {
    const db = openDatabase();
    const config = twoRungConfig({ entry_filters: [] });

    const warmup = candle(0, 2000);
    const liveEntry = candle(1, 2000);
    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce([warmup])
      .mockResolvedValueOnce([liveEntry])
      // Flat position on every tick also hits gridPlacedTick's runaway-check
      // (before the halt gate confirms) — a safe reading (== pEntry) so it
      // never fires, letting the halt path actually run to confirmation.
      .mockResolvedValue([priceReading(2000)]);

    // rung1 gone from the very first observed GRID_PLACED tick, with
    // contracts never moving — looks like an external cancel every tick,
    // confirmed HALTED after the default haltConfirmationTicks (2). One real
    // pollIntervalMs (default 500ms) wait happens between the two
    // confirmation ticks — runBot doesn't expose a way to shorten it.
    const adapter = makeMockAdapter({
      fetchOHLCV,
      fetchOpenOrders: vi.fn().mockResolvedValue([order({ clientOrderId: 'deal-1-2' })]),
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0 })),
    });

    const generateDealId = vi.fn().mockReturnValue('deal-1');

    let t = liveEntry.closeTime;
    await runBot({ adapter, db, config, now: () => t++ }, { generateDealId });

    expect(generateDealId).toHaveBeenCalledTimes(1);
    expect(getDeal(db, 'deal-1')?.status).toBe('HALTED');
  }, 10_000);
});

describe('runBot — graceful shutdown mid-tick (not just between deals)', () => {
  it('stops cleanly once aborted while a deal is actively GRID_PLACED, without closing or halting it', async () => {
    const db = openDatabase();
    const config = twoRungConfig({ entry_filters: [] });
    const controller = new AbortController();

    const warmup = candle(0, 2000);
    const liveEntry = candle(1, 2000);
    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce([warmup])
      .mockResolvedValueOnce([liveEntry])
      .mockResolvedValue([priceReading(2000)]); // gridPlacedTick's runaway-check, if reached — safe reading

    const fetchOpenOrders = vi.fn().mockImplementation(() => {
      controller.abort(); // shutdown requested WHILE this first GRID_PLACED tick is in flight
      return Promise.resolve([order(), order({ clientOrderId: 'deal-1-2' })]); // nothing changed
    });

    const adapter = makeMockAdapter({
      fetchOHLCV,
      fetchOpenOrders,
      fetchPosition: vi.fn().mockResolvedValue(position({ contracts: 0 })),
    });

    const generateDealId = vi.fn().mockReturnValue('deal-1');

    let t = liveEntry.closeTime;
    await runBot(
      { adapter, db, config, now: () => t++ },
      { signal: controller.signal, generateDealId },
    );

    expect(generateDealId).toHaveBeenCalledTimes(1); // no second deal attempted
    expect(getDeal(db, 'deal-1')?.status).toBe('GRID_PLACED'); // neither closed nor halted — just paused
    expect(fetchOpenOrders).toHaveBeenCalledTimes(1); // the in-flight tick finished, no second tick started
  });
});

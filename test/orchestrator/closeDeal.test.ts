import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/storage/db.js';
import { insertDeal, getDeal } from '../../src/storage/dealRepository.js';
import { insertExitOrder, getExitOrdersByDeal } from '../../src/storage/exitOrderRepository.js';
import { closeDeal } from '../../src/orchestrator/closeDeal.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter, OpenOrder } from '../../src/exchange/types.js';

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn(),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchPosition: vi.fn(),
    createOrder: vi.fn(),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    fetchFundingRate: vi.fn(),
    ...overrides,
  };
}

function seed(db: ReturnType<typeof openDatabase>) {
  insertDeal(db, {
    id: 'deal-1',
    status: 'ACTIVE',
    direction: 'long',
    depositUsdt: 200,
    openedAt: 1000,
  });
  insertExitOrder(db, {
    dealId: 'deal-1',
    type: 'tp',
    clientOrderId: 'deal-1-tp',
    price: 2020,
    createdAt: 1000,
  });
}

describe('closeDeal — TP fill (MVP §5: ACTIVE -> SETTLING)', () => {
  it('detects the TP fill, cancels remaining orders, and settles the deal with reason=tp', async () => {
    const db = openDatabase();
    seed(db);
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'e1',
          clientOrderId: 'deal-1-tp',
          side: 'sell',
          price: 2020,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: true,
        },
      ] satisfies OpenOrder[])
      .mockResolvedValue([]); // TP no longer open -> filled

    const adapter = makeMockAdapter({ fetchOpenOrders });
    let t = 5000;

    const result = await closeDeal({
      adapter,
      db,
      config,
      now: () => t++,
      dealId: 'deal-1',
      avgEntry: 2000,
      filledRungsCount: 1,
      exitClientOrderId: 'deal-1-tp',
      stopLossClientOrderId: null,
      pollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    expect(result.closeReason).toBe('tp');
    expect(adapter.cancelAll).toHaveBeenCalledWith('ETH/USDT:USDT');

    const deal = getDeal(db, 'deal-1');
    expect(deal?.status).toBe('SETTLING');
    expect(deal?.closeReason).toBe('tp');
    expect(deal?.closedAt).toBe(result.closedAt);

    const exitOrders = getExitOrdersByDeal(db, 'deal-1');
    expect(exitOrders[0]?.status).toBe('filled');
  });

  it('detects an SL fill instead when both TP and SL are resting and SL disappears first', async () => {
    const db = openDatabase();
    seed(db);
    insertExitOrder(db, {
      dealId: 'deal-1',
      type: 'sl',
      clientOrderId: 'deal-1-sl',
      price: 1900,
      createdAt: 1000,
    });
    const config = buildConfig({ take_profit_pct: 1, stop_loss: 5 });

    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'e1',
          clientOrderId: 'deal-1-tp',
          side: 'sell',
          price: 2020,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: true,
        },
        {
          id: 'e2',
          clientOrderId: 'deal-1-sl',
          side: 'sell',
          price: 1900,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: true,
        },
      ] satisfies OpenOrder[])
      .mockResolvedValue([
        {
          id: 'e1',
          clientOrderId: 'deal-1-tp',
          side: 'sell',
          price: 2020,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: true,
        },
      ] satisfies OpenOrder[]); // SL gone -> filled, TP still resting

    const adapter = makeMockAdapter({ fetchOpenOrders });

    const result = await closeDeal({
      adapter,
      db,
      config,
      now: () => 6000,
      dealId: 'deal-1',
      avgEntry: 2000,
      filledRungsCount: 1,
      exitClientOrderId: 'deal-1-tp',
      stopLossClientOrderId: 'deal-1-sl',
      pollIntervalMs: 1,
      fillTimeoutMs: 1000,
    });

    expect(result.closeReason).toBe('sl');
    const deal = getDeal(db, 'deal-1');
    expect(deal?.closeReason).toBe('sl');
  });

  it('propagates a timeout if neither exit order fills in time', async () => {
    const db = openDatabase();
    seed(db);
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const adapter = makeMockAdapter({
      fetchOpenOrders: vi.fn().mockResolvedValue([
        {
          id: 'e1',
          clientOrderId: 'deal-1-tp',
          side: 'sell',
          price: 2020,
          amount: 0.03,
          filled: 0,
          status: 'open',
          reduceOnly: true,
        },
      ] satisfies OpenOrder[]),
    });

    await expect(
      closeDeal({
        adapter,
        db,
        config,
        now: () => 6000,
        dealId: 'deal-1',
        avgEntry: 2000,
        filledRungsCount: 1,
        exitClientOrderId: 'deal-1-tp',
        stopLossClientOrderId: null,
        pollIntervalMs: 1,
        fillTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

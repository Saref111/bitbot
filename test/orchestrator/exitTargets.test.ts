import { describe, expect, it, vi } from 'vitest';
import { reconcileExitTargets } from '../../src/orchestrator/exitTargets.js';
import { OrderNotFoundError } from '../../src/exchange/errors.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter } from '../../src/exchange/types.js';
import type { ExitOrderRow } from '../../src/storage/types.js';

function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn(),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchPosition: vi.fn(),
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

function exitRow(overrides: Partial<ExitOrderRow> = {}): ExitOrderRow {
  return {
    id: 1,
    dealId: 'deal-1',
    type: 'tp',
    clientOrderId: 'deal-1-tp-0',
    price: 2020,
    amount: 0.03,
    status: 'placed',
    createdAt: 1000,
    filledAt: null,
    cancelledAt: null,
    filledSize: 0,
    ...overrides,
  };
}

describe('reconcileExitTargets — level-check (MVP §5/§6: reprice on avg change)', () => {
  it('does nothing when the resting TP already matches the desired price', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const tp = exitRow({ price: 2000 * 1.01 });
    const adapter = makeMockAdapter();

    const mutations = await reconcileExitTargets({
      adapter,
      config,
      dealId: 'deal-1',
      desiredTakeProfitPrice: 2000 * 1.01,
      desiredStopLossPrice: null,
      positionContracts: 0.03,
      restingExitOrders: [tp],
      allExitOrders: [tp],
      now: () => 5000,
    });

    expect(mutations).toEqual([]);
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('cancels and replaces the TP when the desired price has moved, using a deterministic next clientOrderId', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const tp = exitRow({ clientOrderId: 'deal-1-tp-0', price: 2000 * 1.01 });
    const adapter = makeMockAdapter();

    const mutations = await reconcileExitTargets({
      adapter,
      config,
      dealId: 'deal-1',
      desiredTakeProfitPrice: 1950 * 1.01, // avg moved down after averaging -> new TP target is lower
      desiredStopLossPrice: null,
      positionContracts: 0.05,
      restingExitOrders: [tp],
      allExitOrders: [tp],
      now: () => 5000,
    });

    expect(adapter.cancelOrder).toHaveBeenCalledWith(config.symbol, 'deal-1-tp-0');
    expect(adapter.createOrder).toHaveBeenCalledWith({
      symbol: config.symbol,
      side: 'sell',
      type: 'limit',
      amount: 0.05,
      price: 1950 * 1.01,
      clientOrderId: 'deal-1-tp-1',
      reduceOnly: true,
    });
    expect(mutations).toEqual([
      { kind: 'cancelled', clientOrderId: 'deal-1-tp-0', cancelledAt: 5000 },
      {
        kind: 'inserted',
        exitOrder: {
          dealId: 'deal-1',
          type: 'tp',
          clientOrderId: 'deal-1-tp-1',
          price: 1950 * 1.01,
          amount: 0.05,
          createdAt: 5000,
        },
      },
    ]);
  });

  it('reprices SL independently of TP when both are resting and the desired prices moved', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: 5 });
    const tp = exitRow({ type: 'tp', clientOrderId: 'deal-1-tp-0', price: 2000 * 1.01 });
    const sl = exitRow({ type: 'sl', clientOrderId: 'deal-1-sl-0', price: 2000 * 0.95 });
    const adapter = makeMockAdapter();

    const mutations = await reconcileExitTargets({
      adapter,
      config,
      dealId: 'deal-1',
      desiredTakeProfitPrice: 1950 * 1.01,
      desiredStopLossPrice: 1950 * 0.95,
      positionContracts: 0.05,
      restingExitOrders: [tp, sl],
      allExitOrders: [tp, sl],
      now: () => 5000,
    });

    const clientOrderIds = mutations.flatMap((m) =>
      m.kind === 'inserted' ? [m.exitOrder.clientOrderId] : [],
    );
    expect(clientOrderIds.sort()).toEqual(['deal-1-sl-1', 'deal-1-tp-1']);
  });

  it('never touches an SL row when desiredStopLossPrice is null (no target to compare against)', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const sl = exitRow({ type: 'sl', clientOrderId: 'deal-1-sl-0', price: 1234 });
    const adapter = makeMockAdapter();

    const mutations = await reconcileExitTargets({
      adapter,
      config,
      dealId: 'deal-1',
      desiredTakeProfitPrice: 1950 * 1.01,
      desiredStopLossPrice: null,
      positionContracts: 0.05,
      restingExitOrders: [sl],
      allExitOrders: [sl],
      now: () => 5000,
    });

    expect(mutations).toEqual([]);
    expect(adapter.cancelOrder).not.toHaveBeenCalled();
  });

  it('treats a cancel race (order already filled) as a no-op, not an error', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const tp = exitRow({ clientOrderId: 'deal-1-tp-0', price: 2000 * 1.01 });
    const adapter = makeMockAdapter({
      cancelOrder: vi.fn().mockRejectedValue(new OrderNotFoundError('gone')),
    });

    const mutations = await reconcileExitTargets({
      adapter,
      config,
      dealId: 'deal-1',
      desiredTakeProfitPrice: 1950 * 1.01,
      desiredStopLossPrice: null,
      positionContracts: 0.05,
      restingExitOrders: [tp],
      allExitOrders: [tp],
      now: () => 5000,
    });

    expect(mutations).toEqual([]);
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('propagates a genuine cancelOrder error (not a fill race)', async () => {
    const config = buildConfig({ take_profit_pct: 1, stop_loss: null });
    const tp = exitRow({ clientOrderId: 'deal-1-tp-0', price: 2000 * 1.01 });
    const adapter = makeMockAdapter({
      cancelOrder: vi.fn().mockRejectedValue(new Error('network error')),
    });

    await expect(
      reconcileExitTargets({
        adapter,
        config,
        dealId: 'deal-1',
        desiredTakeProfitPrice: 1950 * 1.01,
        desiredStopLossPrice: null,
        positionContracts: 0.05,
        restingExitOrders: [tp],
        allExitOrders: [tp],
        now: () => 5000,
      }),
    ).rejects.toThrow(/network error/);
  });
});

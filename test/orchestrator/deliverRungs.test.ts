import { describe, expect, it, vi } from 'vitest';
import { deliverNextRungs } from '../../src/orchestrator/deliverRungs.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { ExchangeAdapter } from '../../src/exchange/types.js';
import type { GridOrderRow } from '../../src/storage/types.js';

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
    ...overrides,
  };
}

function row(overrides: Partial<GridOrderRow> = {}): GridOrderRow {
  return {
    id: 1,
    dealId: 'deal-1',
    rungIndex: 1,
    price: 1897.74,
    size: 0.018,
    clientOrderId: 'deal-1-1',
    status: 'pending',
    createdAt: 1000,
    placedAt: null,
    filledAt: null,
    cancelledAt: null,
    fillPrice: null,
    filledSize: 0,
    ...overrides,
  };
}

describe('deliverNextRungs (MVP §4.3: partial_placement K)', () => {
  it('places only the first K pending rungs, ascending by rungIndex', async () => {
    const config = buildConfig({ grid: { partial_placement: 2 } });
    const gridOrders = [
      row({ rungIndex: 3, clientOrderId: 'deal-1-3' }),
      row({ rungIndex: 1, clientOrderId: 'deal-1-1' }),
      row({ rungIndex: 2, clientOrderId: 'deal-1-2' }),
    ];
    const adapter = makeMockAdapter();

    const mutations = await deliverNextRungs({ adapter, config, gridOrders, now: () => 5000 });

    expect(adapter.createOrder).toHaveBeenCalledTimes(2);
    expect(adapter.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ clientOrderId: 'deal-1-1' }),
    );
    expect(adapter.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ clientOrderId: 'deal-1-2' }),
    );
    expect(mutations).toEqual([
      { clientOrderId: 'deal-1-1', patch: { status: 'placed', placedAt: 5000 } },
      { clientOrderId: 'deal-1-2', patch: { status: 'placed', placedAt: 5000 } },
    ]);
  });

  it('delivers every pending rung when partial_placement is null', async () => {
    const config = buildConfig({ grid: { partial_placement: null } });
    const gridOrders = [
      row({ rungIndex: 1, clientOrderId: 'deal-1-1' }),
      row({ rungIndex: 2, clientOrderId: 'deal-1-2' }),
      row({ rungIndex: 3, clientOrderId: 'deal-1-3' }),
    ];
    const adapter = makeMockAdapter();

    const mutations = await deliverNextRungs({ adapter, config, gridOrders, now: () => 5000 });

    expect(adapter.createOrder).toHaveBeenCalledTimes(3);
    expect(mutations).toHaveLength(3);
  });

  it('tops up only the remaining slots when some rungs are already live', async () => {
    const config = buildConfig({ grid: { partial_placement: 2 } });
    const gridOrders = [
      row({ rungIndex: 1, clientOrderId: 'deal-1-1', status: 'filled' }),
      row({ rungIndex: 2, clientOrderId: 'deal-1-2', status: 'placed' }),
      row({ rungIndex: 3, clientOrderId: 'deal-1-3', status: 'pending' }),
      row({ rungIndex: 4, clientOrderId: 'deal-1-4', status: 'pending' }),
    ];
    const adapter = makeMockAdapter();

    // 1 live ('placed'), K=2 -> exactly 1 slot to fill -> next pending is rung 3.
    const mutations = await deliverNextRungs({ adapter, config, gridOrders, now: () => 6000 });

    expect(adapter.createOrder).toHaveBeenCalledTimes(1);
    expect(adapter.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: 'deal-1-3' }),
    );
    expect(mutations).toEqual([
      { clientOrderId: 'deal-1-3', patch: { status: 'placed', placedAt: 6000 } },
    ]);
  });

  it('does nothing when already at K live rungs', async () => {
    const config = buildConfig({ grid: { partial_placement: 1 } });
    const gridOrders = [
      row({ rungIndex: 1, clientOrderId: 'deal-1-1', status: 'placed' }),
      row({ rungIndex: 2, clientOrderId: 'deal-1-2', status: 'pending' }),
    ];
    const adapter = makeMockAdapter();

    const mutations = await deliverNextRungs({ adapter, config, gridOrders, now: () => 6000 });

    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it('places orders with the rung’s own price/size (already exchange-ready from gridReady.ts upstream)', async () => {
    const config = buildConfig({ grid: { partial_placement: 1 } });
    const gridOrders = [
      row({ rungIndex: 1, clientOrderId: 'deal-1-1', price: 1897.74, size: 0.018 }),
    ];
    const adapter = makeMockAdapter();

    await deliverNextRungs({ adapter, config, gridOrders, now: () => 6000 });

    expect(adapter.createOrder).toHaveBeenCalledWith({
      symbol: config.symbol,
      side: 'buy',
      type: 'limit',
      amount: 0.018,
      price: 1897.74,
      clientOrderId: 'deal-1-1',
    });
  });
});

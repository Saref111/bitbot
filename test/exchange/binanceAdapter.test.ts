import { describe, expect, it, vi } from 'vitest';
import { OrderNotFound } from 'ccxt';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
import { OrderNotFoundError } from '../../src/exchange/types.js';
import type { CcxtLike } from '../../src/exchange/binanceAdapter.js';

function makeMockClient(overrides: Partial<CcxtLike> = {}): CcxtLike {
  return {
    loadMarkets: vi.fn().mockResolvedValue({}),
    setPositionMode: vi.fn().mockResolvedValue({}),
    setMarginMode: vi.fn().mockResolvedValue({}),
    setLeverage: vi.fn().mockResolvedValue({}),
    market: vi.fn(),
    fetchOHLCV: vi.fn().mockResolvedValue([]),
    fetchPositions: vi.fn().mockResolvedValue([]),
    createOrder: vi.fn(),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelOrder: vi.fn().mockResolvedValue({}),
    cancelAllOrders: vi.fn().mockResolvedValue([]),
    fetchFundingRate: vi.fn(),
    fetchMyTrades: vi.fn().mockResolvedValue([]),
    fetchFundingHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('createBinanceAdapter — setupSymbol', () => {
  it('loads markets, then sets one-way position mode, margin mode, then leverage, in that order', async () => {
    const client = makeMockClient();
    const adapter = createBinanceAdapter(client);

    await adapter.setupSymbol('ETH/USDT:USDT', 3, 'cross');

    expect(client.loadMarkets).toHaveBeenCalled();
    expect(client.setPositionMode).toHaveBeenCalledWith(false, 'ETH/USDT:USDT');
    expect(client.setMarginMode).toHaveBeenCalledWith('cross', 'ETH/USDT:USDT');
    expect(client.setLeverage).toHaveBeenCalledWith(3, 'ETH/USDT:USDT');
  });

  it('treats "No need to change position side" as success, not a failure', async () => {
    const client = makeMockClient({
      setPositionMode: vi
        .fn()
        .mockRejectedValue(
          new Error('binanceusdm {"code":-4059,"msg":"No need to change position side."}'),
        ),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.setupSymbol('ETH/USDT:USDT', 3, 'cross')).resolves.toBeUndefined();
    expect(client.setMarginMode).toHaveBeenCalledWith('cross', 'ETH/USDT:USDT');
    expect(client.setLeverage).toHaveBeenCalledWith(3, 'ETH/USDT:USDT');
  });

  it('treats "No need to change margin type" as success, not a failure', async () => {
    const client = makeMockClient({
      setMarginMode: vi
        .fn()
        .mockRejectedValue(
          new Error('binanceusdm {"code":-4046,"msg":"No need to change margin type."}'),
        ),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.setupSymbol('ETH/USDT:USDT', 3, 'cross')).resolves.toBeUndefined();
    expect(client.setLeverage).toHaveBeenCalledWith(3, 'ETH/USDT:USDT');
  });

  it('still throws on a genuinely different setPositionMode/setMarginMode error', async () => {
    const client = makeMockClient({
      setPositionMode: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'binanceusdm {"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}',
          ),
        ),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.setupSymbol('ETH/USDT:USDT', 3, 'cross')).rejects.toThrow(/recvWindow/);
  });
});

describe('createBinanceAdapter — getMarketInfo', () => {
  it('loads markets before reading market(), so it works right after construction', async () => {
    const client = makeMockClient({
      market: vi.fn().mockReturnValue({
        precision: { price: 0.01, amount: 0.001 },
        limits: { cost: { min: 5 } },
      }),
    });
    const adapter = createBinanceAdapter(client);

    await adapter.getMarketInfo('ETH/USDT:USDT');

    expect(client.loadMarkets).toHaveBeenCalled();
  });

  it('maps precision.price/amount and limits.cost.min to tickSize/stepSize/minNotional', async () => {
    const client = makeMockClient({
      market: vi.fn().mockReturnValue({
        precision: { price: 0.01, amount: 0.001 },
        limits: { cost: { min: 5 } },
      }),
    });
    const adapter = createBinanceAdapter(client);

    const info = await adapter.getMarketInfo('ETH/USDT:USDT');

    expect(info).toEqual({
      symbol: 'ETH/USDT:USDT',
      tickSize: 0.01,
      stepSize: 0.001,
      minNotional: 5,
    });
  });

  it('throws when market info is incomplete', async () => {
    const client = makeMockClient({
      market: vi.fn().mockReturnValue({ precision: { price: 0.01 }, limits: {} }),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.getMarketInfo('ETH/USDT:USDT')).rejects.toThrow(/incomplete market info/);
  });
});

describe('createBinanceAdapter — fetchOHLCV', () => {
  it('maps ccxt OHLCV tuples to Candle objects with a derived closeTime', async () => {
    const client = makeMockClient({
      fetchOHLCV: vi.fn().mockResolvedValue([[1_000, 100, 105, 95, 102, 10]]),
    });
    const adapter = createBinanceAdapter(client);

    const candles = await adapter.fetchOHLCV('ETH/USDT:USDT', '1m');

    expect(candles).toEqual([
      { openTime: 1_000, closeTime: 1_000 + 60_000, open: 100, high: 105, low: 95, close: 102 },
    ]);
  });

  it('throws on an incomplete OHLCV row', async () => {
    const client = makeMockClient({
      fetchOHLCV: vi.fn().mockResolvedValue([[1_000, 100, undefined, 95, 102, 10]]),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.fetchOHLCV('ETH/USDT:USDT', '1m')).rejects.toThrow(/incomplete OHLCV/);
  });
});

describe('createBinanceAdapter — fetchPosition', () => {
  it('calls fetchPositions (plural) with the symbol, not fetchPosition (singular)', async () => {
    const client = makeMockClient({ fetchPositions: vi.fn().mockResolvedValue([]) });
    const adapter = createBinanceAdapter(client);

    await adapter.fetchPosition('ETH/USDT:USDT');

    expect(client.fetchPositions).toHaveBeenCalledWith(['ETH/USDT:USDT']);
  });

  it('reports side=null and contracts=0 when flat (empty positions array)', async () => {
    const client = makeMockClient({ fetchPositions: vi.fn().mockResolvedValue([]) });
    const adapter = createBinanceAdapter(client);

    expect(await adapter.fetchPosition('ETH/USDT:USDT')).toEqual({
      symbol: 'ETH/USDT:USDT',
      side: null,
      contracts: 0,
      entryPrice: null,
      liquidationPrice: null,
    });
  });

  it('reports side=null and contracts=0 when flat (position present with contracts=0)', async () => {
    const client = makeMockClient({
      fetchPositions: vi
        .fn()
        .mockResolvedValue([{ symbol: 'ETH/USDT:USDT', contracts: 0, side: undefined }]),
    });
    const adapter = createBinanceAdapter(client);

    expect(await adapter.fetchPosition('ETH/USDT:USDT')).toEqual({
      symbol: 'ETH/USDT:USDT',
      side: null,
      contracts: 0,
      entryPrice: null,
      liquidationPrice: null,
    });
  });

  it('maps an open long position, including liquidationPrice', async () => {
    const client = makeMockClient({
      fetchPositions: vi.fn().mockResolvedValue([
        {
          symbol: 'ETH/USDT:USDT',
          contracts: 0.05,
          side: 'long',
          entryPrice: 1901.5,
          liquidationPrice: 1200,
        },
      ]),
    });
    const adapter = createBinanceAdapter(client);

    expect(await adapter.fetchPosition('ETH/USDT:USDT')).toEqual({
      symbol: 'ETH/USDT:USDT',
      side: 'long',
      contracts: 0.05,
      entryPrice: 1901.5,
      liquidationPrice: 1200,
    });
  });
});

describe('createBinanceAdapter — createOrder', () => {
  it('passes clientOrderId through params and maps the response', async () => {
    const client = makeMockClient({
      createOrder: vi
        .fn()
        .mockResolvedValue({ id: 'ex-1', clientOrderId: 'deal-1-1', status: 'open' }),
    });
    const adapter = createBinanceAdapter(client);

    const result = await adapter.createOrder({
      symbol: 'ETH/USDT:USDT',
      side: 'buy',
      type: 'limit',
      amount: 0.01,
      price: 1897.74,
      clientOrderId: 'deal-1-1',
    });

    expect(client.createOrder).toHaveBeenCalledWith(
      'ETH/USDT:USDT',
      'limit',
      'buy',
      0.01,
      1897.74,
      { clientOrderId: 'deal-1-1' },
    );
    expect(result).toEqual({ id: 'ex-1', clientOrderId: 'deal-1-1', status: 'open' });
  });

  it('forwards reduceOnly:true only when requested', async () => {
    const client = makeMockClient({
      createOrder: vi.fn().mockResolvedValue({ id: 'ex-2', clientOrderId: 'tp-1', status: 'open' }),
    });
    const adapter = createBinanceAdapter(client);

    await adapter.createOrder({
      symbol: 'ETH/USDT:USDT',
      side: 'sell',
      type: 'limit',
      amount: 0.01,
      price: 1920,
      clientOrderId: 'tp-1',
      reduceOnly: true,
    });

    expect(client.createOrder).toHaveBeenCalledWith('ETH/USDT:USDT', 'limit', 'sell', 0.01, 1920, {
      clientOrderId: 'tp-1',
      reduceOnly: true,
    });
  });

  it('treats a duplicate clientOrderId (-4116, verified on testnet) as idempotent success, not a failure (Slice 9: crash-retry after createOrder but before the DB write commits)', async () => {
    const client = makeMockClient({
      createOrder: vi
        .fn()
        .mockRejectedValue(
          new Error('binanceusdm {"code":-4116,"msg":"ClientOrderId is duplicated."}'),
        ),
    });
    const adapter = createBinanceAdapter(client);

    const result = await adapter.createOrder({
      symbol: 'ETH/USDT:USDT',
      side: 'buy',
      type: 'limit',
      amount: 0.01,
      price: 1897.74,
      clientOrderId: 'deal-1-1',
    });

    expect(result).toEqual({ id: '', clientOrderId: 'deal-1-1', status: 'open' });
  });

  it('still throws on a genuinely different createOrder error', async () => {
    const client = makeMockClient({
      createOrder: vi
        .fn()
        .mockRejectedValue(new Error('binanceusdm {"code":-2019,"msg":"Margin is insufficient."}')),
    });
    const adapter = createBinanceAdapter(client);

    await expect(
      adapter.createOrder({
        symbol: 'ETH/USDT:USDT',
        side: 'buy',
        type: 'limit',
        amount: 0.01,
        price: 1897.74,
        clientOrderId: 'deal-1-1',
      }),
    ).rejects.toThrow(/Margin is insufficient/);
  });
});

describe('createBinanceAdapter — fetchOpenOrders / cancelAll', () => {
  it('maps open orders', async () => {
    const client = makeMockClient({
      fetchOpenOrders: vi.fn().mockResolvedValue([
        {
          id: 'ex-1',
          clientOrderId: 'deal-1-1',
          side: 'buy',
          price: 1897.74,
          amount: 0.01,
          filled: 0,
          status: 'open',
          reduceOnly: false,
        },
      ]),
    });
    const adapter = createBinanceAdapter(client);

    expect(await adapter.fetchOpenOrders('ETH/USDT:USDT')).toEqual([
      {
        id: 'ex-1',
        clientOrderId: 'deal-1-1',
        side: 'buy',
        price: 1897.74,
        amount: 0.01,
        filled: 0,
        status: 'open',
        reduceOnly: false,
      },
    ]);
  });

  it('cancelAll calls cancelAllOrders for the symbol', async () => {
    const client = makeMockClient();
    const adapter = createBinanceAdapter(client);

    await adapter.cancelAll('ETH/USDT:USDT');

    expect(client.cancelAllOrders).toHaveBeenCalledWith('ETH/USDT:USDT');
  });
});

describe('createBinanceAdapter — cancelOrder', () => {
  it('cancels by clientOrderId via params, not the positional id', async () => {
    const client = makeMockClient();
    const adapter = createBinanceAdapter(client);

    await adapter.cancelOrder('ETH/USDT:USDT', 'deal-1-tp');

    expect(client.cancelOrder).toHaveBeenCalledWith('', 'ETH/USDT:USDT', {
      origClientOrderId: 'deal-1-tp',
    });
  });

  it('maps ccxt OrderNotFound to the adapter-level OrderNotFoundError (Slice 9: reprice race tolerance)', async () => {
    const client = makeMockClient({
      cancelOrder: vi.fn().mockRejectedValue(new OrderNotFound('binanceusdm order does not exist')),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.cancelOrder('ETH/USDT:USDT', 'deal-1-tp')).rejects.toThrow(
      OrderNotFoundError,
    );
  });

  it('propagates any other cancelOrder error unchanged', async () => {
    const client = makeMockClient({
      cancelOrder: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const adapter = createBinanceAdapter(client);

    await expect(adapter.cancelOrder('ETH/USDT:USDT', 'deal-1-tp')).rejects.toThrow(
      /network error/,
    );
  });
});

describe('createBinanceAdapter — fetchFundingRate', () => {
  it('maps fundingRate and fundingTimestamp', async () => {
    const client = makeMockClient({
      fetchFundingRate: vi.fn().mockResolvedValue({ fundingRate: 0.0001, fundingTimestamp: 123 }),
    });
    const adapter = createBinanceAdapter(client);

    expect(await adapter.fetchFundingRate('ETH/USDT:USDT')).toEqual({
      fundingRate: 0.0001,
      fundingTimestamp: 123,
    });
  });
});

describe('createBinanceAdapter — fetchTrades (Slice 10: NET)', () => {
  it('maps side/price/amount/cost/fee/takerOrMaker and passes since through', async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([
      {
        timestamp: 1000,
        side: 'buy',
        price: 1996,
        amount: 0.15,
        cost: 299.4,
        fee: { cost: 0.1198, currency: 'USDT' },
        takerOrMaker: 'maker',
      },
      {
        timestamp: 2000,
        side: 'sell',
        price: 2016,
        amount: 0.15,
        cost: 302.4,
        fee: { cost: 0.121, currency: 'USDT' },
        takerOrMaker: 'taker',
      },
    ]);
    const client = makeMockClient({ fetchMyTrades });
    const adapter = createBinanceAdapter(client);

    const trades = await adapter.fetchTrades('ETH/USDT:USDT', 1000);

    expect(fetchMyTrades).toHaveBeenCalledWith('ETH/USDT:USDT', 1000);
    expect(trades).toEqual([
      {
        timestamp: 1000,
        side: 'buy',
        price: 1996,
        amount: 0.15,
        cost: 299.4,
        feeCost: 0.1198,
        feeCurrency: 'USDT',
        takerOrMaker: 'maker',
      },
      {
        timestamp: 2000,
        side: 'sell',
        price: 2016,
        amount: 0.15,
        cost: 302.4,
        feeCost: 0.121,
        feeCurrency: 'USDT',
        takerOrMaker: 'taker',
      },
    ]);
  });

  it('maps an unrecognized takerOrMaker value to "unknown" rather than guessing', async () => {
    const client = makeMockClient({
      fetchMyTrades: vi.fn().mockResolvedValue([
        {
          timestamp: 1000,
          side: 'buy',
          price: 1996,
          amount: 0.15,
          cost: 299.4,
          fee: { cost: 0.1, currency: 'USDT' },
          takerOrMaker: undefined,
        },
      ]),
    });
    const adapter = createBinanceAdapter(client);

    const [trade] = await adapter.fetchTrades('ETH/USDT:USDT', 1000);
    expect(trade?.takerOrMaker).toBe('unknown');
  });
});

describe('createBinanceAdapter — fetchFundingHistory (Slice 10: NET)', () => {
  it('maps timestamp/amount and passes since + a generous explicit limit through', async () => {
    const fetchFundingHistory = vi.fn().mockResolvedValue([
      { timestamp: 1500, amount: -0.05 }, // long paying funding — the common case
      { timestamp: 30000, amount: 0.02 },
    ]);
    const client = makeMockClient({ fetchFundingHistory });
    const adapter = createBinanceAdapter(client);

    const history = await adapter.fetchFundingHistory('ETH/USDT:USDT', 1000);

    expect(fetchFundingHistory).toHaveBeenCalledWith('ETH/USDT:USDT', 1000, 1000);
    expect(history).toEqual([
      { timestamp: 1500, amount: -0.05 },
      { timestamp: 30000, amount: 0.02 },
    ]);
  });
});

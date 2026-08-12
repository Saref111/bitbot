import { describe, expect, it, vi } from 'vitest';
import { createBinanceAdapter } from '../../src/exchange/binanceAdapter.js';
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
    cancelAllOrders: vi.fn().mockResolvedValue([]),
    fetchFundingRate: vi.fn(),
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

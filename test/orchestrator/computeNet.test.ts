import { describe, expect, it, vi } from 'vitest';
import { computeNet } from '../../src/orchestrator/computeNet.js';
import type { ExchangeAdapter, FundingPayment, TradeInfo } from '../../src/exchange/types.js';

function trade(overrides: Partial<TradeInfo> = {}): TradeInfo {
  return {
    timestamp: 1000,
    side: 'buy',
    price: 2000,
    amount: 0.15,
    cost: 300,
    feeCost: 0.12,
    feeCurrency: 'USDT',
    takerOrMaker: 'maker',
    ...overrides,
  };
}

function makeAdapter(trades: TradeInfo[], funding: FundingPayment[]): ExchangeAdapter {
  return {
    setupSymbol: vi.fn(),
    getMarketInfo: vi.fn(),
    fetchOHLCV: vi.fn(),
    fetchPosition: vi.fn(),
    createOrder: vi.fn(),
    fetchOpenOrders: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAll: vi.fn(),
    fetchFundingRate: vi.fn(),
    fetchTrades: vi.fn().mockResolvedValue(trades),
    fetchFundingHistory: vi.fn().mockResolvedValue(funding),
  };
}

describe('computeNet — MVP §7, §13.4', () => {
  it('computes NET from one entry fill, one exit fill, and funding the long PAID (negative amount)', async () => {
    // Entry: buy 0.15 @ 2000 (cost 300, maker fee 0.12).
    // Exit: sell 0.15 @ 2020 (cost 303, taker fee 0.1515).
    // Funding: -0.5 (long paid it — the common, and sign-critical, case).
    const adapter = makeAdapter(
      [
        trade({ side: 'buy', cost: 300, feeCost: 0.12 }),
        trade({ side: 'sell', cost: 303, feeCost: 0.1515, takerOrMaker: 'taker' }),
      ],
      [{ timestamp: 1500, amount: -0.5 }],
    );

    const result = await computeNet(adapter, 'ETH/USDT:USDT', 1000);

    // grossProfit = 303 - 300 = 3
    // totalFees = 0.12 + 0.1515 = 0.2715
    // totalFunding = -0.5
    // netProfit = 3 - 0.2715 + (-0.5) = 2.2285
    expect(result.grossProfit).toBeCloseTo(3, 9);
    expect(result.totalFees).toBeCloseTo(0.2715, 9);
    expect(result.totalFunding).toBeCloseTo(-0.5, 9);
    expect(result.netProfit).toBeCloseTo(2.2285, 9);
  });

  it('would silently invert the sign if funding were subtracted instead of added — this locks the correct formula', async () => {
    const adapter = makeAdapter(
      [
        trade({ side: 'buy', cost: 300, feeCost: 0 }),
        trade({ side: 'sell', cost: 300, feeCost: 0 }),
      ],
      [{ timestamp: 1500, amount: -10 }],
    );

    const result = await computeNet(adapter, 'ETH/USDT:USDT', 1000);

    // grossProfit=0, fees=0 -> netProfit must equal totalFunding exactly (-10),
    // not +10, which is what a `- totalFunding` bug would produce.
    expect(result.netProfit).toBeCloseTo(-10, 9);
  });

  it('excludes a fee paid in a non-quote currency, with a WARN, rather than silently summing or ignoring it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter(
      [
        trade({ side: 'buy', cost: 300, feeCost: 0.12, feeCurrency: 'USDT' }),
        trade({ side: 'sell', cost: 303, feeCost: 0.0005, feeCurrency: 'BNB' }),
      ],
      [],
    );

    const result = await computeNet(adapter, 'ETH/USDT:USDT', 1000);

    expect(result.totalFees).toBeCloseTo(0.12, 9); // only the USDT-denominated fee counted
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BNB'));
    warnSpy.mockRestore();
  });

  it('passes since through to fetchTrades/fetchFundingHistory and applies no upper bound', async () => {
    const fetchTrades = vi.fn().mockResolvedValue([]);
    const fetchFundingHistory = vi.fn().mockResolvedValue([]);
    const adapter: ExchangeAdapter = {
      ...makeAdapter([], []),
      fetchTrades,
      fetchFundingHistory,
    };

    await computeNet(adapter, 'ETH/USDT:USDT', 12345);

    expect(fetchTrades).toHaveBeenCalledWith('ETH/USDT:USDT', 12345);
    expect(fetchTrades).toHaveBeenCalledTimes(1);
    expect(fetchFundingHistory).toHaveBeenCalledWith('ETH/USDT:USDT', 12345);
  });
});

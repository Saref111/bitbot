import { describe, expect, it, vi } from 'vitest';
import { watchForEntry } from '../../src/feed/liveFeed.js';
import { requireAt } from '../../src/util/arrays.js';
import { sleep } from '../../src/util/time.js';
import { buildConfig } from '../helpers/buildConfig.js';
import { candle, defaultMarket as market } from '../helpers/fixtures.js';
import type { ExchangeAdapter } from '../../src/exchange/types.js';
import type { EntryFilter } from '../../src/config/types.js';
import type { Logger } from '../../src/logging/logger.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function makeAdapter(fetchOHLCV: ExchangeAdapter['fetchOHLCV']): ExchangeAdapter {
  return {
    setupSymbol: vi.fn().mockResolvedValue(undefined),
    getMarketInfo: vi.fn().mockResolvedValue(market),
    fetchOHLCV,
    fetchPosition: vi.fn(),
    createOrder: vi.fn(),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    cancelAll: vi.fn().mockResolvedValue(undefined),
    fetchFundingRate: vi.fn(),
    fetchTrades: vi.fn().mockResolvedValue([]),
    fetchFundingHistory: vi.fn().mockResolvedValue([]),
  };
}

describe('watchForEntry — empty filters (MVP §3: enter immediately)', () => {
  it('warms up on history (without acting on it), then signals on the first genuinely new candle', async () => {
    const config = buildConfig({ entry_filters: [] });
    const warmup = [candle(0, 100), candle(1, 101), candle(2, 102)];
    const newCandle = candle(3, 103);

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup) // warm-up fetch
      .mockResolvedValueOnce([newCandle]); // first live poll
    const adapter = makeAdapter(fetchOHLCV);

    const signal = await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 3,
      pollIntervalMs: 1,
    });

    expect(signal).toEqual({ price: 103, closeTime: newCandle.closeTime });
    // closedBars(3) + 1 padding for the still-forming bar Binance always
    // returns last (Sprint 3 Task A) — see watchForEntry's warm-up fetch.
    expect(fetchOHLCV).toHaveBeenCalledWith('ETH/USDT:USDT', '1m', undefined, 4);
  });

  it('does not re-trigger on a candle already processed in an earlier poll', async () => {
    const config = buildConfig({ entry_filters: [] });
    const warmup = [candle(0, 100)];
    const alreadySeen = candle(1, 101);
    const genuinelyNew = candle(2, 102);

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValueOnce([alreadySeen]) // consumed as the "first new" candle -> would signal here
      .mockResolvedValueOnce([alreadySeen]) // stale re-fetch, must be skipped
      .mockResolvedValueOnce([alreadySeen, genuinelyNew]);
    const adapter = makeAdapter(fetchOHLCV);

    const signal = await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 1,
      pollIntervalMs: 1,
    });

    // Entry fires on the very first new candle (alreadySeen, index 1) since
    // filters are empty — this test's real point is exercised by the dedup
    // test below with a non-empty filter that can't trigger on candle 1.
    expect(signal?.price).toBe(101);
  });
});

describe('watchForEntry — does not treat a still-forming bar as closed (MVP §5 bar_close)', () => {
  it('skips a candle whose closeTime is still in the future, then ingests it once it actually closes', async () => {
    // Binance's fetchOHLCV always returns the currently-forming bar as its
    // last element. period=1 RSI with op '>' -1 is always true once
    // computable, so any premature ingest would fire immediately on the
    // forming read's price (999) instead of waiting for the real close (101).
    const filter: EntryFilter = {
      indicator: 'RSI',
      timeframe: '1m',
      period: 1,
      op: '>',
      value: -1,
    };
    const config = buildConfig({ entry_filters: [filter] });

    const warmup = [candle(0, 100)];
    const forming = candle(1, 999); // same bar, still mid-formation
    const closed = candle(1, 101); // same openTime, now actually closed

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValueOnce([forming])
      .mockResolvedValueOnce([closed]);
    const adapter = makeAdapter(fetchOHLCV);

    const nowValues = [requireAt(warmup, 0).closeTime, forming.closeTime - 1, closed.closeTime];
    let nowIndex = 0;
    const now = (): number => {
      const value = requireAt(nowValues, Math.min(nowIndex, nowValues.length - 1));
      nowIndex++;
      return value;
    };

    const signal = await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 1,
      pollIntervalMs: 1,
      now,
    });

    expect(signal?.price).toBe(101); // the closed read, never the forming one's 999
    expect(fetchOHLCV).toHaveBeenCalledTimes(3); // warm-up + skipped poll + the poll that found it closed
  });
});

describe('watchForEntry — dedup across polls with a real filter', () => {
  it('does not double-process a candle seen in a previous poll', async () => {
    const filter: EntryFilter = {
      indicator: 'RSI',
      timeframe: '1m',
      period: 1,
      op: '>',
      value: -1,
    };
    const config = buildConfig({ entry_filters: [filter] });

    const warmup = [candle(0, 100)];
    const c1 = candle(1, 101);
    const c2 = candle(2, 102);

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValueOnce([c1]) // new
      .mockResolvedValueOnce([c1]) // same candle again -> must be skipped, not double-counted
      .mockResolvedValueOnce([c1, c2]); // c2 is genuinely new
    const adapter = makeAdapter(fetchOHLCV);

    const signal = await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 1,
      pollIntervalMs: 1,
    });

    // period=1 RSI needs only 2 closes, so it's already computable at c1;
    // op '>' -1 is always true, so entry should fire at c1, not later.
    expect(signal?.price).toBe(101);
    expect(fetchOHLCV).toHaveBeenCalledTimes(2); // warm-up + the single poll that found c1
  });
});

describe('watchForEntry — graceful shutdown (AbortSignal)', () => {
  it('resolves null instead of waiting forever when aborted before entry fires', async () => {
    const config = buildConfig({ entry_filters: [] });
    const warmup = [candle(0, 100)];
    const controller = new AbortController();

    // Never actually signals entry (empty poll every time) — without the
    // abort, this would loop forever.
    const fetchOHLCV = vi.fn().mockResolvedValueOnce(warmup).mockResolvedValue([]);
    const adapter = makeAdapter(fetchOHLCV);

    const signalPromise = watchForEntry({
      adapter,
      config,
      warmupClosedBars: 1,
      pollIntervalMs: 60_000, // long enough that only the abort race arm can win promptly
      signal: controller.signal,
    });

    await sleep(5);
    controller.abort();

    await expect(signalPromise).resolves.toBeNull();
  });

  it('never calls fetchOHLCV again once already aborted', async () => {
    const config = buildConfig({ entry_filters: [] });
    const warmup = [candle(0, 100)];
    const controller = new AbortController();
    controller.abort(); // aborted before watchForEntry is even called

    const fetchOHLCV = vi
      .fn()
      .mockResolvedValueOnce(warmup)
      .mockResolvedValue([candle(1, 101)]);
    const adapter = makeAdapter(fetchOHLCV);

    const signal = await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 1,
      pollIntervalMs: 1,
      signal: controller.signal,
    });

    expect(signal).toBeNull();
    expect(fetchOHLCV).toHaveBeenCalledTimes(1); // only the warm-up fetch, no poll
  });
});

describe('watchForEntry — native per-timeframe warm-up (Sprint 3 Task A)', () => {
  it('fetches each tracked timeframe natively, one fetchOHLCV call per timeframe (not 1m aggregation)', async () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 1, op: '>', value: -1 };
    const filter1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter5m, filter1h] });

    const seenTimeframes: string[] = [];
    const fetchOHLCV: ExchangeAdapter['fetchOHLCV'] = (...args) => {
      seenTimeframes.push(args[1]);
      return Promise.resolve([candle(0, 100)]);
    };
    const adapter = makeAdapter(fetchOHLCV);

    const controller = new AbortController();
    controller.abort(); // warm-up still runs in full; only the live poll loop is skipped

    await watchForEntry({ adapter, config, warmupClosedBars: 1, signal: controller.signal });

    expect([...seenTimeframes].sort()).toEqual(['1h', '1m', '5m']);
  });

  it('logs a fetch-gap WARN when a tracked timeframe returns fewer closed bars than requested', async () => {
    const filter1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter1h] });

    const fetchOHLCV: ExchangeAdapter['fetchOHLCV'] = (...args) => {
      if (args[1] === '1h') return Promise.resolve([candle(0, 100)]); // only 1, requested 5
      return Promise.resolve([]);
    };
    const adapter = makeAdapter(fetchOHLCV);
    const logger = makeLogger();

    const controller = new AbortController();
    controller.abort();
    await watchForEntry({
      adapter,
      config,
      warmupClosedBars: 5,
      signal: controller.signal,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeframe: '1h', requested: 5, received: 1 }),
      expect.stringContaining('fetch-gap'),
    );
  });
});

describe('watchForEntry — warm-up self-check logging (Sprint 3 Task A)', () => {
  it('logs exactly one INFO line per filter, after warm-up and before the live poll loop', async () => {
    const filter5m: EntryFilter = { indicator: 'RSI', timeframe: '5m', period: 1, op: '>', value: -1 };
    const filter1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 1, op: '>', value: -1 };
    const config = buildConfig({ entry_filters: [filter5m, filter1h] });

    const fetchOHLCV: ExchangeAdapter['fetchOHLCV'] = () =>
      Promise.resolve([candle(0, 100), candle(1, 101)]);
    const adapter = makeAdapter(fetchOHLCV);
    const logger = makeLogger();

    const controller = new AbortController();
    controller.abort();
    await watchForEntry({ adapter, config, warmupClosedBars: 1, signal: controller.signal, logger });

    expect(logger.info).toHaveBeenCalledTimes(2); // one per filter, not one combined line
    const calls = (logger.info as ReturnType<typeof vi.fn>).mock.calls as [
      Record<string, unknown>,
      string,
    ][];
    expect(calls.map(([entry]) => entry.timeframe)).toEqual(['5m', '1h']);
    const [firstEntry] = requireAt(calls, 0);
    expect(firstEntry).toMatchObject({ indicator: 'RSI', timeframe: '5m', period: 1 });
    expect(typeof firstEntry.converged).toBe('boolean');
  });
});

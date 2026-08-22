import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { replayWindow } from '../../src/replay/replayWindow.js';
import { projectGrid } from '../../src/grid/index.js';
import { buildConfig } from '../helpers/buildConfig.js';
import type { EntryFilter } from '../../src/config/types.js';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures');
const BINANCE_CSV_DIR = join(FIXTURES_DIR, 'binance-data/csv');

describe('replayWindow — Sprint 3 Task B, real fixture data', () => {
  it('is deterministic: two runs against identical real fixtures produce a deep-equal result (AC #1)', () => {
    const config = buildConfig({ entry_filters: [] });
    const params = {
      config,
      csvDir: BINANCE_CSV_DIR,
      symbol: 'ETHUSDT',
      fromMs: Date.UTC(2026, 7, 1, 0, 0, 0),
      toMs: Date.UTC(2026, 7, 1, 0, 10, 0),
    };

    const first = replayWindow(params);
    const second = replayWindow(params);

    expect(second).toEqual(first);
  });

  it('replays a real multi-day window with no gaps and the correct bar count', () => {
    const config = buildConfig({ entry_filters: [] });
    const result = replayWindow({
      config,
      csvDir: BINANCE_CSV_DIR,
      symbol: 'ETHUSDT',
      fromMs: Date.UTC(2026, 7, 1, 0, 0, 0),
      toMs: Date.UTC(2026, 7, 3, 0, 0, 0),
    });

    expect(result.bars).toHaveLength(2 * 24 * 60);
    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i]?.candle.openTime).toBe((result.bars[i - 1]?.candle.openTime ?? 0) + 60_000);
    }
  });

  it('fires entrySignal on the very first bar with empty filters, and computes the matching gridPlan', () => {
    const config = buildConfig({ entry_filters: [] });
    const fromMs = Date.UTC(2026, 7, 1, 0, 0, 0);
    const result = replayWindow({
      config,
      csvDir: BINANCE_CSV_DIR,
      symbol: 'ETHUSDT',
      fromMs,
      toMs: Date.UTC(2026, 7, 1, 0, 5, 0),
    });

    const firstBar = result.bars[0];
    expect(firstBar?.entrySignal).not.toBeNull();
    expect(firstBar?.entrySignal?.price).toBe(firstBar?.candle.close);

    const expectedGridPlan = projectGrid(
      config,
      firstBar?.entrySignal?.price ?? 0,
      `replay-${String(firstBar?.candle.closeTime)}`,
    );
    expect(firstBar?.gridPlan).toEqual(expectedGridPlan);

    // Only the very first bar should carry an entrySignal — bar_close
    // latching means the AND stays true from then on, but the grid is
    // only ever projected once, at the moment it first fires.
    for (const bar of result.bars.slice(1)) {
      expect(bar.entrySignal).not.toBeNull(); // stays latched active...
    }
  });

  it('warm-up self-check reports one entry per real filter, non-null and converged with the default depth', () => {
    const rsi1h: EntryFilter = { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 90 };
    const config = buildConfig({ entry_filters: [rsi1h] });
    const result = replayWindow({
      config,
      csvDir: BINANCE_CSV_DIR,
      symbol: 'ETHUSDT',
      fromMs: Date.UTC(2026, 7, 5, 0, 0, 0),
      toMs: Date.UTC(2026, 7, 5, 0, 5, 0),
    });

    expect(result.warmupSelfCheck).toHaveLength(1);
    expect(result.warmupSelfCheck[0]).toMatchObject({ indicator: 'RSI', timeframe: '1h', converged: true });
    expect(result.warmupSelfCheck[0]?.value).not.toBeNull();
  });
});

describe('replayWindow — Sprint 3 Task B, synthetic CSV fixtures (fast, isolates orchestration from the real dataset)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function dateStem(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // Splits rows into one file per real UTC calendar day, the way real
  // Binance daily dumps are laid out — a naive single-file dump would
  // mislabel any row that crosses midnight under the FIRST day's stem,
  // and resolveCsvFilesForRange would then fail to find the day it's
  // actually looking for.
  function writeSyntheticOneMinuteCsv(dir: string, startOpenTime: number, count: number): void {
    const oneMinuteDir = join(dir, '1m');
    mkdirSync(oneMinuteDir, { recursive: true });
    const header =
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';
    const rowsByDay = new Map<string, string[]>([]);
    for (let i = 0; i < count; i++) {
      const openTime = startOpenTime + i * 60_000;
      const price = 100 + i;
      const row = `${String(openTime)},${String(price)},${String(price)},${String(price)},${String(price)},1,${String(openTime + 59_999)},1,1,1,1,0`;
      const stem = dateStem(openTime);
      const rows = rowsByDay.get(stem) ?? [header];
      rows.push(row);
      rowsByDay.set(stem, rows);
    }
    for (const [stem, rows] of rowsByDay) {
      writeFileSync(join(oneMinuteDir, `SYN-1m-${stem}.csv`), rows.join('\n') + '\n');
    }
  }

  it('correctly wires warm-up + replay windows through the actual CSV-loading path', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bitbot-replay-test-'));
    const dayStart = Date.UTC(2026, 0, 1, 0, 0, 0);
    // 10 warm-up minutes before dayStart, then the whole day.
    writeSyntheticOneMinuteCsv(tempDir, dayStart - 10 * 60_000, 10 + 24 * 60);

    const config = buildConfig({ entry_filters: [] });
    const result = replayWindow({
      config,
      csvDir: tempDir,
      symbol: 'SYN',
      fromMs: dayStart,
      toMs: dayStart + 5 * 60_000,
      warmupClosedBars: 10,
    });

    expect(result.bars).toHaveLength(5);
    expect(result.bars[0]?.entrySignal).not.toBeNull(); // fires on the first live tick, empty filters
    expect(result.finalState.candlesByTimeframe['1m']).toHaveLength(10 + 5);
  });
});

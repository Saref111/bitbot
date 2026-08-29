import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAt } from '../util/index.js';
import { TIMEFRAME_DURATION_MS } from '../candles/index.js';
import type { Candle } from '../candles/index.js';
import type { CsvCandleSourceOptions } from './types.js';

const ONE_DAY_MS = 24 * 60 * 60_000;

/**
 * Sprint 3 Task B: parses a Binance data.binance.vision klines CSV.
 * closeTime is ALWAYS derived as openTime + durationMs, never read from
 * the CSV's own close_time column (column 7) — that column is
 * openTime + duration - 1ms (confirmed against a real dump), and trusting
 * it would desync the native/live splice boundary Task A established by
 * 1ms. Header row is detected, not assumed present (older Binance dumps
 * sometimes omit it — every file downloaded for this sprint has one, but
 * this must not be hardcoded on that).
 */
export function parseCandleCsvContent(text: string, durationMs: number): Candle[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const candles: Candle[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = requireAt(lines, i);
    const fields = line.split(',');
    if (i === 0 && !/^\d+$/.test(requireAt(fields, 0))) {
      continue; // header row, not data
    }
    if (fields.length < 5) {
      throw new Error(`parseCandleCsvContent: line ${String(i + 1)} has fewer than 5 fields: '${line}'`);
    }

    const openTime = Number(requireAt(fields, 0));
    const open = Number(requireAt(fields, 1));
    const high = Number(requireAt(fields, 2));
    const low = Number(requireAt(fields, 3));
    const close = Number(requireAt(fields, 4));
    if ([openTime, open, high, low, close].some((n) => Number.isNaN(n))) {
      throw new Error(`parseCandleCsvContent: line ${String(i + 1)} has a non-numeric OHLC field: '${line}'`);
    }

    candles.push({ openTime, closeTime: openTime + durationMs, open, high, low, close });
  }

  return candles;
}

export function parseCandleCsvFile(filePath: string, durationMs: number): Candle[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`parseCandleCsvFile: cannot read '${filePath}': ${String(error)}`);
  }
  return parseCandleCsvContent(text, durationMs);
}

function utcDateStem(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y)}-${m}-${day}`;
}

function utcMonthStem(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${String(y)}-${m}`;
}

/**
 * One file per UTC calendar day touched by [fromMs, toMs): prefers a daily
 * dump (ETHUSDT-<tf>-YYYY-MM-DD.csv) if present, else falls back to the
 * monthly dump (ETHUSDT-<tf>-YYYY-MM.csv) covering that day. Deduplicates
 * repeated file paths (several days falling in the same monthly file).
 */
export function resolveCsvFilesForRange(
  options: CsvCandleSourceOptions,
  fromMs: number,
  toMs: number,
): string[] {
  const { dir, symbol, timeframe } = options;
  const tfDir = join(dir, timeframe);
  const files: string[] = [];

  // Normalize to the UTC day boundary containing fromMs first — otherwise
  // stepping by exactly ONE_DAY_MS from an arbitrary (non-midnight) fromMs
  // drifts alongside toMs instead of enumerating calendar days, and can
  // skip the very day a short cross-midnight range actually needs.
  const firstDay = Math.floor(fromMs / ONE_DAY_MS) * ONE_DAY_MS;
  for (let day = firstDay; day < toMs; day += ONE_DAY_MS) {
    const dailyPath = join(tfDir, `${symbol}-${timeframe}-${utcDateStem(day)}.csv`);
    if (existsSync(dailyPath)) {
      if (!files.includes(dailyPath)) files.push(dailyPath);
      continue;
    }
    const monthlyPath = join(tfDir, `${symbol}-${timeframe}-${utcMonthStem(day)}.csv`);
    if (existsSync(monthlyPath)) {
      if (!files.includes(monthlyPath)) files.push(monthlyPath);
      continue;
    }
    throw new Error(
      `resolveCsvFilesForRange: no daily or monthly CSV found for ${utcDateStem(day)} (${timeframe}) under ${tfDir}`,
    );
  }

  return files;
}

/**
 * Loads, concatenates, sorts, dedupes (exact-duplicate rows from an
 * overlapping monthly+daily file pair), filters to [fromMs, toMs), and
 * asserts contiguity — aggregateCandles documents that it assumes
 * contiguous, gap-free 1m input and explicitly leaves gap detection to the
 * caller; this is that caller's guarantee.
 */
export function loadCandles(options: CsvCandleSourceOptions, fromMs: number, toMs: number): Candle[] {
  const durationMs = TIMEFRAME_DURATION_MS[options.timeframe];
  const files = resolveCsvFilesForRange(options, fromMs, toMs);

  const byOpenTime = new Map<number, Candle>();
  for (const file of files) {
    for (const candle of parseCandleCsvFile(file, durationMs)) {
      byOpenTime.set(candle.openTime, candle);
    }
  }

  const candles = [...byOpenTime.values()]
    .filter((c) => c.openTime >= fromMs && c.openTime < toMs)
    .sort((a, b) => a.openTime - b.openTime);

  for (let i = 1; i < candles.length; i++) {
    const prev = requireAt(candles, i - 1);
    const curr = requireAt(candles, i);
    if (curr.openTime !== prev.openTime + durationMs) {
      throw new Error(
        `loadCandles: gap in ${options.timeframe} series between ${String(prev.openTime)} and ${String(curr.openTime)} (expected ${String(prev.openTime + durationMs)})`,
      );
    }
  }

  return candles;
}

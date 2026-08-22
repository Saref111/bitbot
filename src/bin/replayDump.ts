#!/usr/bin/env node
import { supportedTimeframes } from '../candles/index.js';
import type { Timeframe } from '../candles/index.js';
import { loadConfigFromFile } from '../config/index.js';
import { replayWindow, buildFilterDump } from '../replay/index.js';

export interface ReplayDumpArgs {
  csvDir: string;
  symbol: string;
  configPath: string;
  indicator: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  warmupClosedBars?: number;
}

function isTimeframe(value: string): value is Timeframe {
  return (supportedTimeframes as readonly string[]).includes(value);
}

function parseUtcArg(name: string, raw: string): number {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`replayDump: ${name} must be a valid ISO 8601 UTC timestamp, got "${raw}"`);
  }
  return ms;
}

/**
 * Sprint 3 Task C, AC #4 (per-bar spot-check dump tool). Mirrors
 * src/bin/bitbot.ts's parseArgs shape and error-message style. --config is
 * required with no embedded default — this is a QA tool, not a place to
 * duplicate/risk-desyncing the Survivor filter table maintained in
 * docs/MVP-done.md and the Sprint 3 test fixtures.
 */
export function parseArgs(argv: readonly string[]): ReplayDumpArgs {
  let csvDir: string | undefined;
  let symbol: string | undefined;
  let configPath: string | undefined;
  let indicator: string | undefined;
  let timeframe: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let warmupClosedBarsRaw: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv-dir') csvDir = argv[++i];
    else if (argv[i] === '--symbol') symbol = argv[++i];
    else if (argv[i] === '--config') configPath = argv[++i];
    else if (argv[i] === '--indicator') indicator = argv[++i];
    else if (argv[i] === '--timeframe') timeframe = argv[++i];
    else if (argv[i] === '--from') from = argv[++i];
    else if (argv[i] === '--to') to = argv[++i];
    else if (argv[i] === '--warmup-closed-bars') warmupClosedBarsRaw = argv[++i];
  }

  const missing = [
    ['--csv-dir', csvDir],
    ['--symbol', symbol],
    ['--config', configPath],
    ['--indicator', indicator],
    ['--timeframe', timeframe],
    ['--from', from],
    ['--to', to],
  ].filter(([, value]) => value === undefined);
  if (missing.length > 0) {
    throw new Error(
      `replayDump: missing required argument(s): ${missing.map(([flag]) => flag).join(', ')}`,
    );
  }
  if (timeframe !== undefined && !isTimeframe(timeframe)) {
    throw new Error(
      `replayDump: --timeframe must be one of ${supportedTimeframes.join('|')}, got "${timeframe}"`,
    );
  }

  const warmupClosedBars =
    warmupClosedBarsRaw !== undefined ? Number(warmupClosedBarsRaw) : undefined;
  if (warmupClosedBars !== undefined && !Number.isInteger(warmupClosedBars)) {
    throw new Error(
      `replayDump: --warmup-closed-bars must be an integer, got "${String(warmupClosedBarsRaw)}"`,
    );
  }

  return {
    csvDir: csvDir as string,
    symbol: symbol as string,
    configPath: configPath as string,
    indicator: indicator as string,
    timeframe: timeframe as Timeframe,
    fromMs: parseUtcArg('--from', from as string),
    toMs: parseUtcArg('--to', to as string),
    ...(warmupClosedBars !== undefined ? { warmupClosedBars } : {}),
  };
}

function findFilterIndex(
  entryFilters: readonly { indicator: string; timeframe: Timeframe }[],
  indicator: string,
  timeframe: Timeframe,
): number {
  const matches = entryFilters
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f.indicator === indicator && f.timeframe === timeframe);

  if (matches.length === 0) {
    throw new Error(
      `replayDump: no filter matches indicator="${indicator}" timeframe="${timeframe}" in the given config`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `replayDump: ${String(matches.length)} filters match indicator="${indicator}" timeframe="${timeframe}" — ambiguous, refusing to silently pick one`,
    );
  }
  return matches[0]?.index ?? 0;
}

function run(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfigFromFile(args.configPath);
  const filterIndex = findFilterIndex(config.entry_filters, args.indicator, args.timeframe);

  const result = replayWindow({
    config,
    csvDir: args.csvDir,
    symbol: args.symbol,
    fromMs: args.fromMs,
    toMs: args.toMs,
    ...(args.warmupClosedBars !== undefined ? { warmupClosedBars: args.warmupClosedBars } : {}),
  });

  const rows = buildFilterDump(result.bars, filterIndex);

  console.log(`${args.indicator}(${args.timeframe}) — ${String(rows.length)} rows`);
  console.log('sinceCloseTime (UTC)\t\tvalue\tactive');
  for (const row of rows) {
    console.log(
      `${new Date(row.sinceCloseTime).toISOString()}\t${row.value === null ? 'null' : row.value.toFixed(4)}\t${String(row.active)}`,
    );
  }
  const activeCount = rows.filter((r) => r.active).length;
  console.log(
    `\n${String(activeCount)}/${String(rows.length)} active (${rows.length > 0 ? ((activeCount / rows.length) * 100).toFixed(1) : '0.0'}%)`,
  );
}

if (import.meta.main) {
  try {
    run();
  } catch (error: unknown) {
    console.error('replayDump: fatal error', error);
    process.exit(1);
  }
}

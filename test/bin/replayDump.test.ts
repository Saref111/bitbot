import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/bin/replayDump.js';

const REQUIRED_ARGS = [
  '--csv-dir',
  '/data/csv',
  '--symbol',
  'ETHUSDT',
  '--config',
  'survivor.yaml',
  '--indicator',
  'RSI',
  '--timeframe',
  '1h',
  '--from',
  '2026-07-01T00:00:00Z',
  '--to',
  '2026-07-02T00:00:00Z',
];

describe('replayDump parseArgs', () => {
  it('parses all required arguments', () => {
    expect(parseArgs(REQUIRED_ARGS)).toEqual({
      csvDir: '/data/csv',
      symbol: 'ETHUSDT',
      configPath: 'survivor.yaml',
      indicator: 'RSI',
      timeframe: '1h',
      fromMs: Date.parse('2026-07-01T00:00:00Z'),
      toMs: Date.parse('2026-07-02T00:00:00Z'),
    });
  });

  it('throws listing every missing required argument, not just the first', () => {
    expect(() => parseArgs([])).toThrow(
      /--csv-dir.*--symbol.*--config.*--indicator.*--timeframe.*--from.*--to/,
    );
  });

  it('throws when only some required arguments are missing', () => {
    expect(() => parseArgs(['--csv-dir', '/data/csv'])).toThrow(/--symbol/);
  });

  it('rejects an invalid --timeframe with a clear, non-silent error', () => {
    const args = REQUIRED_ARGS.map((v) => (v === '1h' ? '2h' : v));
    expect(() => parseArgs(args)).toThrow(/--timeframe.*1m\|5m\|15m\|30m\|1h.*2h/);
  });

  it('rejects an unparseable --from timestamp', () => {
    const args = REQUIRED_ARGS.map((v) => (v === '2026-07-01T00:00:00Z' ? 'not-a-date' : v));
    expect(() => parseArgs(args)).toThrow(/--from.*not-a-date/);
  });

  it('accepts an optional --warmup-closed-bars', () => {
    const args = [...REQUIRED_ARGS, '--warmup-closed-bars', '150'];
    expect(parseArgs(args)).toMatchObject({ warmupClosedBars: 150 });
  });

  it('omits warmupClosedBars when not given', () => {
    expect(parseArgs(REQUIRED_ARGS)).not.toHaveProperty('warmupClosedBars');
  });

  it('rejects a non-integer --warmup-closed-bars', () => {
    const args = [...REQUIRED_ARGS, '--warmup-closed-bars', 'abc'];
    expect(() => parseArgs(args)).toThrow(/--warmup-closed-bars/);
  });

  it('accepts arguments in any order', () => {
    // Reversing the FLAT array would scramble flag/value pairing (a flag
    // would end up followed by the wrong value) — group into [flag, value]
    // pairs first, reverse the pair order, then flatten.
    const pairs: string[][] = [];
    for (let i = 0; i < REQUIRED_ARGS.length; i += 2) {
      pairs.push([REQUIRED_ARGS[i] as string, REQUIRED_ARGS[i + 1] as string]);
    }
    const shuffled = pairs.reverse().flat();

    expect(parseArgs(shuffled)).toMatchObject({ csvDir: '/data/csv', indicator: 'RSI' });
  });
});

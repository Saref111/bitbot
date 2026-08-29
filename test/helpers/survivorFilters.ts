import type { EntryFilter } from '../../src/config/types.js';

/**
 * The real Survivor bot's 7-filter entry config, confirmed directly in
 * docs/MVP-done.md:132-139 — order
 * matches docs/SPRINT 3.md §2's golden vector 1:1.
 *
 * Shared between Sprint 3 Task C (filterVector.test.ts) and Task D
 * (dealTiming.golden.test.ts): both oracles must run bitbot against the
 * EXACT same real config for their results to be comparable — a silent
 * divergence between two independently-typed copies would produce a false
 * "filters vs deal-machine" triangulation signal with no error to catch it.
 */
export const SURVIVOR_FILTERS: EntryFilter[] = [
  { indicator: 'RSI', timeframe: '1m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '5m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '30m', period: 14, op: '<', value: 50 },
  { indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 },
  { indicator: 'CCI', timeframe: '5m', period: 20, op: '<', value: 70 },
  { indicator: 'CCI', timeframe: '15m', period: 20, op: '<', value: 75 },
  { indicator: 'CCI', timeframe: '1h', period: 20, op: '<', value: 80 },
];

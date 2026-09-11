export type { ExchangeAdapter, OpenOrder, Position, FillWatcher } from './types.js';
export { OrderNotFoundError } from './errors.js';
export { makeGridExchangeReady } from './gridReady.js';
export { createBinanceAdapter } from './binanceAdapter.js';
export { loadExchangeCredentials, loadBybitCredentials } from './credentials.js';
export { createBinanceCcxtClient, createBinanceProCcxtClient } from './binanceClient.js';
export { createBinanceFillWatcher } from './fillWatcher.js';
// Sprint 4 Task C, Slice C3: re-exported so main.ts's wiring branch can
// import through this barrel (import/no-internal-modules only allows
// **/index.js reach-ins) — not new adapter behavior, just making the
// existing Slices C1/C2 symbols reachable from outside src/exchange/.
export { createBybitAdapter } from './bybitAdapter.js';
export { createBybitCcxtClient, createBybitProCcxtClient } from './bybitClient.js';

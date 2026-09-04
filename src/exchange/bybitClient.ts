import { bybit, pro } from 'ccxt';
import type { BybitProClient, ExchangeCredentials } from './types.js';

/**
 * Sprint 4 Task C: unlike Binance (separate binance/binanceusdm/binancecoinm
 * classes per market type), ccxt's Bybit is ONE unified class across
 * spot/linear/inverse/option — market type is chosen by symbol/category, not
 * by class. No explicit category/defaultType override here: ccxt's own
 * bybit.js already defaults to `defaultType: 'swap'` + `defaultSubType:
 * 'linear'` (verified by reading node_modules/ccxt/js/src/bybit.js), which
 * is exactly USDT-margined linear perpetuals — what ETHUSDT-perp needs.
 *
 * **`enableDemoTrading(true)`, NOT `setSandboxMode(true)`** — deliberate
 * divergence from binanceClient.ts, found empirically on Slice C1's first
 * real connectivity attempt. The key itself was a Bybit Demo Trading key
 * from the start (not mainnet) — the bug was calling the wrong ccxt method
 * for it. `setSandboxMode(true)` routes to Bybit's true testnet
 * (`urls.test`, api-testnet.{hostname}), a SEPARATE account/key system
 * registered at testnet.bybit.com — a Demo Trading key was never
 * registered there, so it rejected outright
 * (`{"retCode":10003,"retMsg":"API key is invalid."}`), regardless of the
 * key's own trading permissions. `enableDemoTrading(true)` routes to the
 * environment the key actually belongs to (`urls.demotrading`,
 * api-demo.{hostname}) — same safety property CLAUDE.md cares about (no
 * real funds at risk, key has no withdraw right), just a different
 * ccxt-level mechanism than Binance's single testnet toggle. Bonus:
 * `fetchCurrencies()` (bybit.js:1778-1785,
 * called unconditionally inside `loadMarkets()` since bybit.js declares
 * native `fetchCurrencies: true`) hits a private Asset-scope endpoint
 * (`/v5/asset/coin/query-info`) our trading-only key permissions don't
 * cover — `enableDemoTrading` short-circuits that call entirely
 * (bybit.js:1782: `if (this.options['enableDemoTrading']) return {};`),
 * sidestepping the permission gap rather than requiring a wider key scope.
 * `bybit.js` overrides the base `Exchange.enableDemoTrading` with its own
 * version keyed off `urls.demotrading` (bybit.js:1400-1419) — the generic
 * base-class version reads `urls.demo`, which bybit.js never declares, so
 * calling this only works because of that per-exchange override. Confirmed
 * by local inspection (no network call): after `enableDemoTrading(true)`,
 * `client.urls['api']` resolves to `https://api-demo.{hostname}` for every
 * category.
 *
 * WS (pro client below) inherits this correctly too, confirmed by source,
 * not just by class-extension assumption: `pro/bybit.js`'s
 * `getUrlByMarketType` (line 191) reads `this.urls['api']['ws']` — the exact
 * field `enableDemoTrading` swaps — and `urls.demotrading.ws.private.contract`
 * (pro/bybit.js:113) is `wss://stream-demo.{hostname}/v5/private`, matching
 * the shape `getUrlByMarketType` indexes into for a private linear-swap
 * stream. So `watchOrders` on this client routes to the demo private stream,
 * not mainnet, once `enableDemoTrading(true)` runs.
 *
 * The only place a real ccxt client gets constructed — everything else
 * depends on the narrow CcxtLike interface.
 */
export function createBybitCcxtClient(credentials: ExchangeCredentials): bybit {
  const client = new bybit({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
  });
  if (credentials.testnet) {
    client.enableDemoTrading(true);
  }
  return client;
}

/**
 * MVP §13.5: ccxt's WebSocket ("pro") variant — same package (`ccxt.pro`),
 * a SEPARATE exchange instance from the REST client above since watch*
 * calls are long-lived, not request/response. Same demo-trading setup as
 * the REST client above (see its comment for why `enableDemoTrading`, not
 * `setSandboxMode`), since the user-data-stream needs the same account.
 */
export function createBybitProCcxtClient(credentials: ExchangeCredentials): BybitProClient {
  const client = new pro.bybit({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
  });
  if (credentials.testnet) {
    client.enableDemoTrading(true);
  }
  return client;
}

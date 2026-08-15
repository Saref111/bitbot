import { binanceusdm, pro } from 'ccxt';
import type { ExchangeCredentials } from './credentials.js';

/** The only place a real ccxt client gets constructed — everything else depends on the narrow CcxtLike interface. */
export function createBinanceCcxtClient(credentials: ExchangeCredentials): binanceusdm {
  const client = new binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    // ccxt deprecated its automatic futures sandbox handling and now refuses
    // authenticated testnet.binancefuture.com calls unless this is set —
    // this is the sanctioned way to keep using it, not a workaround.
    ...(credentials.testnet ? { options: { disableFuturesSandboxWarning: true } } : {}),
  });
  if (credentials.testnet) {
    client.setSandboxMode(true);
  }
  return client;
}

type BinanceProClient = InstanceType<(typeof pro)['binanceusdm']>;

/**
 * MVP §13.5: ccxt's WebSocket ("pro") variant — same package (`ccxt.pro`,
 * verified present at the installed version, no new dependency), a
 * SEPARATE exchange instance from the REST client above since watch* calls
 * are long-lived, not request/response. Same testnet/sandbox setup as the
 * REST client, since the user-data-stream needs the same account.
 */
export function createBinanceProCcxtClient(credentials: ExchangeCredentials): BinanceProClient {
  const client = new pro.binanceusdm({
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
    ...(credentials.testnet ? { options: { disableFuturesSandboxWarning: true } } : {}),
  });
  if (credentials.testnet) {
    client.setSandboxMode(true);
  }
  return client;
}

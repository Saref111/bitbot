import { binanceusdm } from 'ccxt';
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

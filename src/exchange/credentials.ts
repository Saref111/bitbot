import type { ExchangeCredentials } from './types.js';

export function loadExchangeCredentials(): ExchangeCredentials {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  const testnetRaw = process.env.BINANCE_TESTNET;

  if (!apiKey) {
    throw new Error('loadExchangeCredentials: BINANCE_API_KEY must be set in .env');
  }
  if (!apiSecret) {
    throw new Error('loadExchangeCredentials: BINANCE_API_SECRET must be set in .env');
  }
  if (testnetRaw !== 'true' && testnetRaw !== 'false') {
    throw new Error('loadExchangeCredentials: BINANCE_TESTNET must be "true" or "false" in .env');
  }

  return { apiKey, apiSecret, testnet: testnetRaw === 'true' };
}

// Sprint 4 Task C, Slice C3: a SEPARATE function, deliberately duplicating
// loadExchangeCredentials rather than generalizing it into
// loadCredentials(exchange) — consistent with Task A §0 ("designing an
// abstraction off a sample of two exchanges is guessing"), applied here to
// the credentials loader the same way it was applied to the adapters.
// Generalize when a third exchange shows up, not before.
export function loadBybitCredentials(): ExchangeCredentials {
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  const testnetRaw = process.env.BYBIT_TESTNET;

  if (!apiKey) {
    throw new Error('loadBybitCredentials: BYBIT_API_KEY must be set in .env');
  }
  if (!apiSecret) {
    throw new Error('loadBybitCredentials: BYBIT_API_SECRET must be set in .env');
  }
  if (testnetRaw !== 'true' && testnetRaw !== 'false') {
    throw new Error('loadBybitCredentials: BYBIT_TESTNET must be "true" or "false" in .env');
  }

  return { apiKey, apiSecret, testnet: testnetRaw === 'true' };
}

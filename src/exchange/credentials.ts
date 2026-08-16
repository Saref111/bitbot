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

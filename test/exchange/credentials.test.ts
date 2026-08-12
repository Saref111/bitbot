import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExchangeCredentials } from '../../src/exchange/credentials.js';

const ENV_KEYS = ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BINANCE_TESTNET'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

describe('loadExchangeCredentials', () => {
  it('reads apiKey/apiSecret/testnet from process.env', () => {
    process.env.BINANCE_API_KEY = 'test-key';
    process.env.BINANCE_API_SECRET = 'test-secret';
    process.env.BINANCE_TESTNET = 'true';

    expect(loadExchangeCredentials()).toEqual({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      testnet: true,
    });
  });

  it('parses BINANCE_TESTNET=false', () => {
    process.env.BINANCE_API_KEY = 'k';
    process.env.BINANCE_API_SECRET = 's';
    process.env.BINANCE_TESTNET = 'false';

    expect(loadExchangeCredentials().testnet).toBe(false);
  });

  it('throws when BINANCE_API_KEY is missing', () => {
    process.env.BINANCE_API_SECRET = 's';
    process.env.BINANCE_TESTNET = 'true';
    expect(() => loadExchangeCredentials()).toThrow(/BINANCE_API_KEY/);
  });

  it('throws when BINANCE_API_SECRET is missing', () => {
    process.env.BINANCE_API_KEY = 'k';
    process.env.BINANCE_TESTNET = 'true';
    expect(() => loadExchangeCredentials()).toThrow(/BINANCE_API_SECRET/);
  });

  it('throws when BINANCE_TESTNET is missing or not "true"/"false"', () => {
    process.env.BINANCE_API_KEY = 'k';
    process.env.BINANCE_API_SECRET = 's';
    expect(() => loadExchangeCredentials()).toThrow(/BINANCE_TESTNET/);

    process.env.BINANCE_TESTNET = 'yes';
    expect(() => loadExchangeCredentials()).toThrow(/BINANCE_TESTNET/);
  });
});

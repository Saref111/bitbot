import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from '../../src/config/loadConfig.js';
import { ConfigError } from '../../src/config/errors.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/config');

describe('loadConfigFromFile', () => {
  it('loads the full Survivor preset and matches MVP.md §3 values 1:1', () => {
    const config = loadConfigFromFile(path.join(fixturesDir, 'survivor-valid.yaml'));

    expect(config.symbol).toBe('ETH/USDT:USDT');
    expect(config.direction).toBe('long');
    expect(config.deposit_usdt).toBe(200);
    expect(config.leverage).toBe(3);
    expect(config.reinvest_pct).toBe(20);
    expect(config.entry_filters).toHaveLength(7);
    expect(config.grid).toEqual({
      overlap_pct: 35,
      orders: 14,
      martingale_pct: 3,
      indent_pct: 0.2,
      log_distribution: 1.3,
      partial_placement: 3,
      runaway_cancel_pct: 0.5,
    });
    expect(config.take_profit_pct).toBe(0.9);
    expect(config.stop_loss).toBeNull();
  });

  it('loads a minimal valid config (empty filters, null fields)', () => {
    const config = loadConfigFromFile(path.join(fixturesDir, 'minimal-valid.yaml'));

    expect(config.entry_filters).toEqual([]);
    expect(config.grid.partial_placement).toBeNull();
    expect(config.stop_loss).toBeNull();
  });

  it('throws a ConfigError with a field-specific message for an invalid config file', () => {
    let thrown: unknown;
    try {
      loadConfigFromFile(path.join(fixturesDir, 'invalid-negative-deposit.yaml'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const configError = thrown as ConfigError;
    expect(configError.issues.some((issue) => issue.path === 'deposit_usdt')).toBe(true);
  });

  it('throws a ConfigError for malformed YAML, not a raw parser exception', () => {
    expect(() => loadConfigFromFile(path.join(fixturesDir, 'malformed.yaml'))).toThrow(ConfigError);
  });

  it('throws a ConfigError when the file does not exist', () => {
    expect(() => loadConfigFromFile(path.join(fixturesDir, 'does-not-exist.yaml'))).toThrow(
      ConfigError,
    );
  });
});

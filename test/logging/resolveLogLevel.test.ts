import { describe, expect, it } from 'vitest';
import { resolveLogLevel } from '../../src/logging/resolveLogLevel.js';

describe('resolveLogLevel — priority: CLI > env LOG_LEVEL > config logging.level > default "info"', () => {
  it('defaults to "info" when no source is set', () => {
    expect(resolveLogLevel({})).toBe('info');
  });

  it('uses config.logging.level when only that is set', () => {
    expect(resolveLogLevel({ config: 'warn' })).toBe('warn');
  });

  it('env LOG_LEVEL overrides config', () => {
    expect(resolveLogLevel({ env: 'debug', config: 'warn' })).toBe('debug');
  });

  it('CLI --log-level overrides both env and config', () => {
    expect(resolveLogLevel({ cli: 'trace', env: 'debug', config: 'warn' })).toBe('trace');
  });
});

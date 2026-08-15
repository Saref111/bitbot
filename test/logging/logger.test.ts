import { describe, expect, it, afterEach } from 'vitest';
import { createLogger, createNoopLogger } from '../../src/logging/logger.js';

describe('createLogger — MVP §13.6 (TRACE/DEBUG/INFO/WARN/ERROR, default INFO)', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it('defaults to level "info" when neither an option nor LOG_LEVEL is set', () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger();
    expect(logger.level).toBe('info');
  });

  it('uses LOG_LEVEL from the environment when no explicit option is given', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger();
    expect(logger.level).toBe('debug');
  });

  it('an explicit level option overrides LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = createLogger({ level: 'error' });
    expect(logger.level).toBe('error');
  });

  it('accepts a logFilePath without throwing (real write path exercised via pino/file transport)', () => {
    expect(() => createLogger({ logFilePath: '/tmp/bitbot-test.log' })).not.toThrow();
  });
});

describe('createNoopLogger', () => {
  it('is silent and never throws when logging at any level', () => {
    const logger = createNoopLogger();
    expect(logger.level).toBe('silent');
    expect(() => {
      logger.info('test');
      logger.error('test');
    }).not.toThrow();
  });
});

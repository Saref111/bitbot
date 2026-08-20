import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('accepts a logFilePath without throwing (real write path exercised via pino-roll transport)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bitbot-logger-'));
    try {
      expect(() =>
        createLogger({ logFilePath: join(dir, 'config.log') }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'writes real, one-JSON-object-per-line output to disk when logFilePath is given ' +
      '(pino-roll always suffixes the base name — e.g. config.1.log, never config.log itself)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bitbot-logger-'));
      try {
        const logger = createLogger({ level: 'debug', logFilePath: join(dir, 'config.log') });
        logger.info({ hello: 'world' }, 'first line');
        logger.debug({ n: 2 }, 'second line');

        const rolledFiles = await vi.waitFor(
          () => {
            const files = readdirSync(dir).filter(
              (name) => name.startsWith('config') && name.endsWith('.log'),
            );
            expect(files.length).toBeGreaterThan(0);
            return files;
          },
          { timeout: 2000, interval: 20 },
        );
        expect(rolledFiles).not.toEqual(['config.log']); // confirms the suffixing behavior above

        const content = await vi.waitFor(
          () => {
            const text = readFileSync(join(dir, rolledFiles[0] as string), 'utf-8').trim();
            expect(text.split('\n')).toHaveLength(2);
            return text;
          },
          { timeout: 2000, interval: 20 },
        );

        const lines = content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines[0]).toMatchObject({ hello: 'world', msg: 'first line' });
        expect(lines[1]).toMatchObject({ n: 2, msg: 'second line' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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

import { describe, expect, it } from 'vitest';
import { deriveDefaultDbPath, deriveDefaultLogPath, parseArgs } from '../../src/bin/bitbot.js';

describe('parseArgs', () => {
  it('requires --config', () => {
    expect(() => parseArgs([])).toThrow(/--config/);
    expect(() => parseArgs(['--db', 'foo.db'])).toThrow(/--config/);
  });

  it('parses --config alone, deriving --db and --log-file next to it', () => {
    expect(parseArgs(['--config', '/etc/bitbot/config.yaml'])).toEqual({
      configPath: '/etc/bitbot/config.yaml',
      dbPath: '/etc/bitbot/config.db',
      logFilePath: '/etc/bitbot/config.log',
    });
  });

  it('honors an explicit --db over the derived default', () => {
    expect(parseArgs(['--config', 'config.yaml', '--db', '/var/lib/bitbot/state.db'])).toEqual({
      configPath: 'config.yaml',
      dbPath: '/var/lib/bitbot/state.db',
      logFilePath: 'config.log',
    });
  });

  it('honors an explicit --log-file over the derived default', () => {
    expect(
      parseArgs(['--config', 'config.yaml', '--log-file', '/var/log/bitbot/custom.log']),
    ).toEqual({
      configPath: 'config.yaml',
      dbPath: 'config.db',
      logFilePath: '/var/log/bitbot/custom.log',
    });
  });

  it('accepts the flags in any order', () => {
    expect(
      parseArgs(['--log-file', 'bot.log', '--db', 'state.db', '--config', 'config.yaml']),
    ).toEqual({
      configPath: 'config.yaml',
      dbPath: 'state.db',
      logFilePath: 'bot.log',
    });
  });

  it('omits logLevel when --log-level is not given (logFilePath still always present)', () => {
    expect(parseArgs(['--config', 'config.yaml'])).toEqual({
      configPath: 'config.yaml',
      dbPath: 'config.db',
      logFilePath: 'config.log',
    });
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error'])(
    'accepts --log-level %s',
    (logLevel) => {
      expect(parseArgs(['--config', 'config.yaml', '--log-level', logLevel])).toEqual({
        configPath: 'config.yaml',
        dbPath: 'config.db',
        logFilePath: 'config.log',
        logLevel,
      });
    },
  );

  it('rejects an invalid --log-level with a clear, non-silent error', () => {
    expect(() => parseArgs(['--config', 'config.yaml', '--log-level', 'garbage'])).toThrow(
      /--log-level.*trace\|debug\|info\|warn\|error.*garbage/,
    );
  });
});

describe('deriveDefaultDbPath', () => {
  it('swaps the extension for .db in the same directory', () => {
    expect(deriveDefaultDbPath('/etc/bitbot/config.yaml')).toBe('/etc/bitbot/config.db');
  });

  it('works for a relative, extensionless path too', () => {
    expect(deriveDefaultDbPath('config')).toBe('config.db');
  });

  it('works for a bare filename with no directory', () => {
    expect(deriveDefaultDbPath('config.yaml')).toBe('config.db');
  });
});

describe('deriveDefaultLogPath', () => {
  it('swaps the extension for .log in the same directory', () => {
    expect(deriveDefaultLogPath('/etc/bitbot/config.yaml')).toBe('/etc/bitbot/config.log');
  });

  it('works for a relative, extensionless path too', () => {
    expect(deriveDefaultLogPath('config')).toBe('config.log');
  });

  it('works for a bare filename with no directory', () => {
    expect(deriveDefaultLogPath('config.yaml')).toBe('config.log');
  });
});

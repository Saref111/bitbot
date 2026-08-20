import { describe, expect, it } from 'vitest';
import { deriveDefaultDbPath, parseArgs } from '../../src/bin/bitbot.js';

describe('parseArgs', () => {
  it('requires --config', () => {
    expect(() => parseArgs([])).toThrow(/--config/);
    expect(() => parseArgs(['--db', 'foo.db'])).toThrow(/--config/);
  });

  it('parses --config alone, deriving --db next to it', () => {
    expect(parseArgs(['--config', '/etc/bitbot/config.yaml'])).toEqual({
      configPath: '/etc/bitbot/config.yaml',
      dbPath: '/etc/bitbot/config.db',
    });
  });

  it('honors an explicit --db over the derived default', () => {
    expect(parseArgs(['--config', 'config.yaml', '--db', '/var/lib/bitbot/state.db'])).toEqual({
      configPath: 'config.yaml',
      dbPath: '/var/lib/bitbot/state.db',
    });
  });

  it('accepts the flags in either order', () => {
    expect(parseArgs(['--db', 'state.db', '--config', 'config.yaml'])).toEqual({
      configPath: 'config.yaml',
      dbPath: 'state.db',
    });
  });

  it('omits logLevel when --log-level is not given', () => {
    expect(parseArgs(['--config', 'config.yaml'])).toEqual({
      configPath: 'config.yaml',
      dbPath: 'config.db',
    });
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error'])(
    'accepts --log-level %s',
    (logLevel) => {
      expect(parseArgs(['--config', 'config.yaml', '--log-level', logLevel])).toEqual({
        configPath: 'config.yaml',
        dbPath: 'config.db',
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

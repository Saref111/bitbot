import { describe, expect, it, vi } from 'vitest';
import { announceSessionStop } from '../../src/orchestrator/sessionStop.js';
import { openDatabase } from '../../src/storage/db.js';
import { twoRungConfig } from '../helpers/fixtures.js';
import type { Logger } from '../../src/logging/logger.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 'debug' } as unknown as Logger;
}

describe('announceSessionStop — graceful-shutdown visibility, paired with announceSessionStart', () => {
  it('logs one structured INFO ("session stopping") with symbol/network/pid', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStop({
      config,
      db,
      logger,
      notifier,
      network: 'testnet',
      now: () => 5000,
      pid: 4242,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({ symbol: config.symbol, network: 'testnet', pid: 4242 });
    expect(msg).toBe('session stopping');
  });

  it('writes exactly one session_stopped event_log row, deal-less, symmetric to session_started', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStop({
      config,
      db,
      logger,
      notifier,
      network: 'mainnet',
      now: () => 9000,
      pid: 777,
    });

    const rows = db.prepare('SELECT * FROM event_log').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deal_id).toBeNull();
    expect(rows[0]?.event_type).toBe('session_stopped');
    expect(JSON.parse(rows[0]?.payload_json as string)).toEqual({
      symbol: config.symbol,
      network: 'mainnet',
      pid: 777,
      ts: 9000,
    });
  });

  it('sends a short human Telegram ping mentioning symbol and network', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStop({
      config,
      db,
      logger,
      notifier,
      network: 'testnet',
      now: () => 1000,
    });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [message] = notifier.notify.mock.calls[0] as [string];
    expect(message).toContain(config.symbol);
    expect(message).toContain('testnet');
  });

  it('does not throw when the notifier fails (best-effort, same notifySafely path as session start)', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockRejectedValue(new Error('telegram down')) };
    const db = openDatabase();

    await expect(
      announceSessionStop({ config, db, logger, notifier, network: 'testnet', now: () => 1000 }),
    ).resolves.toBeUndefined();
  });
});

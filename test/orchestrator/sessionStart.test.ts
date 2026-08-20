import { describe, expect, it, vi } from 'vitest';
import { announceSessionStart } from '../../src/orchestrator/sessionStart.js';
import { openDatabase } from '../../src/storage/db.js';
import { twoRungConfig } from '../helpers/fixtures.js';
import type { Logger } from '../../src/logging/logger.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 'debug' } as unknown as Logger;
}

describe('announceSessionStart — startup visibility, before watchForEntry', () => {
  it('logs one structured INFO with symbol/network/mode/level/strategy shape/state', async () => {
    const config = twoRungConfig({
      entry_filters: [{ indicator: 'RSI', timeframe: '1h', period: 14, op: '<', value: 55 }],
    });
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStart({
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
    expect(fields).toMatchObject({
      symbol: config.symbol,
      network: 'testnet',
      mode: 'simple',
      logLevel: 'debug',
      deposit: config.deposit_usdt,
      leverage: config.leverage,
      gridOrders: config.grid.orders,
      takeProfitPct: config.take_profit_pct,
      entryFilters: config.entry_filters,
      state: 'waiting_for_entry',
    });
    expect(msg).toMatch(new RegExp(`${config.symbol}.*testnet.*waiting for entry`));
  });

  it('writes exactly one session_started event_log row, no DEBUG rows, deal-less', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStart({
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
    expect(rows[0]?.event_type).toBe('session_started');
    expect(JSON.parse(rows[0]?.payload_json as string)).toEqual({
      symbol: config.symbol,
      network: 'mainnet',
      pid: 777,
      ts: 9000,
    });
  });

  it('sends a short human Telegram ping mentioning symbol, network, and waiting for entry', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const db = openDatabase();

    await announceSessionStart({
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
    expect(message).toMatch(/waiting for entry/);
  });

  it('does not throw when the notifier fails (best-effort, same as notifySafely elsewhere)', async () => {
    const config = twoRungConfig();
    const logger = makeLogger();
    const notifier = { notify: vi.fn().mockRejectedValue(new Error('telegram down')) };
    const db = openDatabase();

    await expect(
      announceSessionStart({ config, db, logger, notifier, network: 'testnet', now: () => 1000 }),
    ).resolves.toBeUndefined();
  });
});

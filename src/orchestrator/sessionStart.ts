import type { DatabaseSync } from 'node:sqlite';
import { appendEvent } from '../storage/index.js';
import { notifySafely } from './haltGate.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type { Notifier } from '../notify/index.js';

export interface AnnounceSessionStartParams {
  config: Config;
  db: DatabaseSync;
  logger: Logger;
  notifier: Notifier;
  network: 'testnet' | 'mainnet';
  now: () => number;
  /** Injectable for tests; defaults to the real process pid. */
  pid?: number;
}

/**
 * Startup visibility (before watchForEntry, so it's the first thing a
 * human/log sees on a clean start): one structured INFO line, one
 * deal-less event_log row, one best-effort Telegram ping. MVP scope is
 * "Простий" only, so mode is a fixed literal, not something read from
 * config.
 */
export async function announceSessionStart(params: AnnounceSessionStartParams): Promise<void> {
  const { config, db, logger, notifier, network, now } = params;
  const pid = params.pid ?? process.pid;
  const ts = now();
  const msg = `bitbot up on ${config.symbol} ${network}, waiting for entry`;

  logger.info(
    {
      symbol: config.symbol,
      network,
      mode: 'simple',
      logLevel: logger.level,
      deposit: config.deposit_usdt,
      leverage: config.leverage,
      gridOrders: config.grid.orders,
      takeProfitPct: config.take_profit_pct,
      entryFilters: config.entry_filters,
      state: 'waiting_for_entry',
    },
    msg,
  );

  appendEvent(db, {
    dealId: null,
    eventType: 'session_started',
    payload: { symbol: config.symbol, network, pid, ts },
    createdAt: ts,
  });

  await notifySafely(logger, notifier, msg);
}

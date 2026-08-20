import type { DatabaseSync } from 'node:sqlite';
import { appendEvent } from '../storage/index.js';
import { notifySafely } from './haltGate.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type { Notifier } from '../notify/index.js';

export interface AnnounceSessionStopParams {
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
 * Graceful-shutdown visibility, paired with announceSessionStart: one
 * structured INFO line, one deal-less event_log row, one best-effort
 * Telegram ping. Only for a clean signal-triggered stop — the caller
 * (bin/bitbot.ts) decides that, this function doesn't distinguish
 * shutdown from any other reason runBot returned.
 */
export async function announceSessionStop(params: AnnounceSessionStopParams): Promise<void> {
  const { config, db, logger, notifier, network, now } = params;
  const pid = params.pid ?? process.pid;
  const ts = now();
  const msg = `bitbot stopped on ${config.symbol} ${network}`;

  logger.info({ symbol: config.symbol, network, pid }, 'session stopping');

  appendEvent(db, {
    dealId: null,
    eventType: 'session_stopped',
    payload: { symbol: config.symbol, network, pid, ts },
    createdAt: ts,
  });

  await notifySafely(logger, notifier, msg);
}

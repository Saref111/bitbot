import type { DatabaseSync } from 'node:sqlite';
import type { ExchangeAdapter } from '../exchange/types.js';
import type { Config } from '../config/types.js';
import type { Logger } from '../logging/logger.js';
import type { Notifier } from '../notify/types.js';

export interface OrchestratorContext {
  adapter: ExchangeAdapter;
  db: DatabaseSync;
  config: Config;
  /** Injectable clock (real usage: () => Date.now()) — kept out of the functions themselves for testability. */
  now: () => number;
  /** MVP §13.6. Optional — defaults to a silent logger inside runDeal/recoverDeal when omitted, so existing tests never need to supply one. */
  logger?: Logger;
  /** MVP §13.6. Optional — defaults to a no-op notifier when omitted (Telegram is an optional channel). */
  notifier?: Notifier;
}

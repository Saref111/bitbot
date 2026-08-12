import type { DatabaseSync } from 'node:sqlite';
import type { ExchangeAdapter } from '../exchange/types.js';
import type { Config } from '../config/types.js';

export interface OrchestratorContext {
  adapter: ExchangeAdapter;
  db: DatabaseSync;
  config: Config;
  /** Injectable clock (real usage: () => Date.now()) — kept out of the functions themselves for testability. */
  now: () => number;
}

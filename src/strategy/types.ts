import type { Config } from '../config/index.js';

/**
 * decide() only covers an in-flight deal's fill lifecycle (MVP §5, ACTIVE
 * state). Deliberately NOT its job — owned by the orchestrator instead:
 *  - entry filters / WAITING_SIGNAL → GRID_PLACED
 *  - runaway-cancel in GRID_PLACED (price-driven, lives in the orchestrator)
 *  - partial_placement rung delivery bookkeeping
 *  - liquidation / HALTED
 */
export interface DecideContext {
  config: Config;
  /** Fills so far, AFTER the event this call represents (post-event count). */
  filledRungsCount: number;
  /** Real avg entry from the exchange, AFTER the event this call represents. */
  avgEntry: number;
  event: 'rung_filled' | 'tp_filled' | 'sl_filled';
}

export type Intent =
  | { type: 'open'; takeProfitPrice: number; stopLossPrice: number | null }
  | { type: 'safety'; takeProfitPrice: number; stopLossPrice: number | null }
  | { type: 'close'; reason: 'take_profit' | 'stop_loss' };

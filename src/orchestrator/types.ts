import type { DatabaseSync } from 'node:sqlite';
import type { ExchangeAdapter, FillWatcher } from '../exchange/index.js';
import type { Config } from '../config/index.js';
import type { Logger } from '../logging/index.js';
import type { Notifier } from '../notify/index.js';
import type {
  DealCloseReason,
  ExitOrderRow,
  GridOrderPatch,
  GridOrderRow,
  NewExitOrder,
} from '../storage/index.js';

// Module dependency map (verified acyclic — no src/ directory imports back
// "up" this list). orchestrator/ sits at the top and is the only module
// allowed to depend on everything below it.
//
//   util, logging, notify, config          — leaves, no internal imports
//   candles, indicators, filters, grid,
//   strategy                               — domain math, depend only on config/util
//   exchange, storage                      — infra/IO, depend on the domain modules above
//     (exception: exchange/gridReady.ts reads grid/'s GridPlan type — kept
//     intentional, since making a grid-ready order is an exchange-facing
//     concern (tickSize/stepSize/minNotional) that happens to consume a
//     grid/ shape as input, not a generic helper stranded in the wrong
//     module)
//   feed                                   — depends on util/exchange/config/candles/indicators/filters
//   orchestrator                           — depends on all of the above
//   main.ts (src/, not a directory)        — top; depends only on orchestrator/

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

export interface RunDealOptions {
  pollIntervalMs?: number;
  /**
   * How many CONSECUTIVE ticks a cancel/divergence anomaly must repeat
   * before actually halting. fetchPosition/fetchOpenOrders are two separate
   * REST calls, not one atomic snapshot — a one-tick disagreement between
   * them must not be a spontaneous halt for a 24/7 bot (PLAN.md).
   */
  haltConfirmationTicks?: number;
  /**
   * MVP §13.5: optional WS wake-up trigger. Purely a latency optimization —
   * omitted (as in every test that doesn't set it), the loop behaves exactly
   * as before, plain `sleep(pollIntervalMs)`. Never a source of truth: the
   * following tick's reconcileTick always re-derives state from REST
   * regardless of what woke it up.
   */
  fillWatcher?: FillWatcher;
  /**
   * Graceful shutdown (main.ts's SIGINT/SIGTERM handling). Checked only
   * between ticks, never mid-exchange-call: a tick already in flight always
   * finishes normally. Omitted (as in every test that doesn't set it), the
   * loop behaves exactly as before, running until a normal terminal result.
   */
  signal?: AbortSignal;
}

export interface RunDealParams extends OrchestratorContext {
  dealId: string;
  /** Price captured at the moment entry filters align. */
  entryPrice: number;
  options?: RunDealOptions;
}

export type RunDealResult =
  | { outcome: 'closed'; closeReason: DealCloseReason }
  | { outcome: 'runaway' }
  | { outcome: 'halted'; reason: string }
  /** Graceful shutdown, not an error — resumes normally via recoverDeal on the next start. */
  | { outcome: 'shutdown' };

export type RecoverDealResult = RunDealResult | { outcome: 'no-deal' };

export interface RecoverDealParams extends OrchestratorContext {
  dealId: string;
  options?: RunDealOptions;
}

export type ExitTargetMutation =
  | { kind: 'cancelled'; clientOrderId: string; cancelledAt: number }
  | { kind: 'inserted'; exitOrder: NewExitOrder };

export interface ReconcileExitTargetsParams {
  adapter: ExchangeAdapter;
  config: Config;
  dealId: string;
  /**
   * Desired prices — the caller computes these via decide() (the single
   * source of truth for the TP/SL formula, MVP §6); this function is purely
   * a mechanical "make resting orders match" level-check, not a second
   * place that knows the formula.
   */
  desiredTakeProfitPrice: number;
  desiredStopLossPrice: number | null;
  positionContracts: number;
  /** Currently-resting ('placed') exit_order rows only. */
  restingExitOrders: readonly ExitOrderRow[];
  /** Full exit_order history for this deal (placed + cancelled + filled), to derive a stable next clientOrderId per type. */
  allExitOrders: readonly ExitOrderRow[];
  now: () => number;
}

export interface DeliverRungsParams {
  adapter: ExchangeAdapter;
  config: Config;
  gridOrders: readonly GridOrderRow[];
  now: () => number;
}

export interface GridOrderMutation {
  clientOrderId: string;
  patch: GridOrderPatch;
}

export interface AdoptExistingPositionParams extends OrchestratorContext {
  dealId: string;
  options?: RunDealOptions;
}

export interface WaitAndOpenDealParams extends OrchestratorContext {
  dealId: string;
  /** Sprint 3 Task A: closed bars per tracked timeframe, not "total 1m bars" — see WatchForEntryParams.warmupClosedBars. */
  warmupClosedBars?: number;
  feedPollIntervalMs?: number;
  dealPollIntervalMs?: number;
  haltConfirmationTicks?: number;
  /** MVP §13.5 — passed straight through to runDeal's RunDealOptions once the deal opens. */
  fillWatcher?: FillWatcher;
  /** Graceful shutdown — checked both while waiting for entry_filters and, once open, on every runDeal tick. */
  signal?: AbortSignal;
}

export interface NetBreakdown {
  grossProfit: number;
  totalFees: number;
  totalFunding: number;
  netProfit: number;
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

export interface HaltGateState {
  lastSignature: string | null;
  streak: number;
}

export interface TickContext extends OrchestratorContext {
  dealId: string;
  gate: HaltGateState;
  haltConfirmationTicks: number;
  /** Resolved once in runDealLoop (ctx.logger ?? noop) — always present here, unlike on OrchestratorContext. */
  logger: Logger;
  notifier: Notifier;
}

import { openDeal } from './openDeal.js';
import { closeDeal } from './closeDeal.js';
import type { OrchestratorContext } from './types.js';
import type { OpenDealResult } from './openDeal.js';
import type { CloseDealResult } from './closeDeal.js';

export interface RunThinSliceParams extends OrchestratorContext {
  dealId: string;
  entryPrice: number;
  pollIntervalMs?: number;
  fillTimeoutMs?: number;
}

export interface RunThinSliceResult {
  open: OpenDealResult;
  close: CloseDealResult;
}

/**
 * PLAN.md Slice 7: "open -> fill -> TP -> close" as one full pass. Composes
 * openDeal + closeDeal; see each for the state transitions they own.
 *
 * This linear await-chain is Slice 7 scaffolding, not the shape Slice 9's
 * full state machine will use. It hardcodes "exactly one entry fill, then
 * exactly one exit fill" — no partial_placement delivery, no safety-order
 * averaging (multiple grid fills repositioning TP), no runaway-cancel, no
 * HALTED, no restart recovery. Slice 9 needs an event-driven dispatcher
 * (decide() already models events, not an await-sequence) reacting to
 * whichever fill/cancel/tick happens next, not a function that awaits a
 * fixed sequence to completion. Expect this file to be replaced wholesale
 * in Slice 9, not extended in place.
 */
export async function runThinSlice(params: RunThinSliceParams): Promise<RunThinSliceResult> {
  const open = await openDeal(params);
  const close = await closeDeal({
    ...params,
    avgEntry: open.avgEntry,
    filledRungsCount: 1,
    exitClientOrderId: open.exitClientOrderId,
    stopLossClientOrderId: open.stopLossClientOrderId,
  });
  return { open, close };
}

// Same numeric value, deliberately separate constants: EPS tolerances a
// contracts/size-quantity comparison (reconcile.ts, runDeal.ts's flat-check),
// PRICE_EPS tolerances a price-level comparison (exitTargets.ts's reprice
// check) — different physical units that only coincide today, not the same
// concept.
export const EPS = 1e-9;
export const PRICE_EPS = 1e-9;

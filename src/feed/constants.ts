import { type Timeframe } from '../candles/index.js';

// MVP §5: checked from higher timeframes to lower. The final AND result
// doesn't actually depend on this order (each filter updates independently
// of the others), but processing in this order matches the spec.
export const TIMEFRAME_ORDER: readonly Timeframe[] = ['1h', '30m', '15m', '5m', '1m'];

// Sprint 3 Task A (docs/SPRINT 3.md): 0.1%-tolerance convergence for
// period=14 Wilder RSI is ~93 bars past seed + 14 seed bars ≈ 107; 120 gives
// headroom above that threshold. Same bar count applies to every tracked
// timeframe (decay is per-bar, not per-calendar-time).
export const DEFAULT_WARMUP_CLOSED_BARS = 120;

// "Converged" (warm-up self-check) targets the doc's stricter 0.1% figure.
export const CONVERGENCE_TOLERANCE = 0.001;

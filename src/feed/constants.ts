import { type Timeframe } from '../candles/index.js';

// MVP §5: checked from higher timeframes to lower. The final AND result
// doesn't actually depend on this order (each filter updates independently
// of the others), but processing in this order matches the spec.
export const TIMEFRAME_ORDER: readonly Timeframe[] = ['1h', '30m', '15m', '5m', '1m'];

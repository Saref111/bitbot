import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/replay/**/*.test.ts'],
    // Sprint 3 Task B: real offline computation over tens of thousands of
    // real Binance 1m candles (the aggregation cross-check especially) —
    // slower than a typical unit test, but deterministic and offline, NOT
    // "live testnet" (that's what test/integration means) — kept in its
    // own suite/config rather than blurring either existing meaning.
    testTimeout: 30_000,
  },
});

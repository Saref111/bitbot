import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Live testnet calls (order placement, rate limits) need more headroom
    // than the default unit-test timeout.
    testTimeout: 30_000,
    // Sprint 3 Task G: every file here shares ONE real testnet account and
    // symbol (ETH/USDT:USDT). Vitest's default runs test FILES in parallel
    // worker processes — with 4 files all placing/cancelling real orders
    // and opening/closing real positions on the same account, one file's
    // afterAll cancelAll() can race a sibling file's still-in-progress
    // test and cancel its resting order out from under it. Reproduced
    // directly: running with --no-file-parallelism was reliably green
    // across repeated full-suite runs; without it, a real cross-file
    // interference failure showed up (an order confirmed resting via
    // pollUntil was gone again by the time reconcileOrphans looked for
    // it moments later). Forcing sequential files trades suite wall-clock
    // time for not fighting itself over shared real exchange state.
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Live testnet calls (order placement, rate limits) need more headroom
    // than the default unit-test timeout.
    testTimeout: 30_000,
  },
});

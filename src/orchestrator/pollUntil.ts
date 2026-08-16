import { sleep } from '../util/index.js';
import type { PollOptions } from './types.js';

/** Polls `check` until it returns non-null, or throws after `timeoutMs`. */
export async function pollUntil<T>(
  check: () => Promise<T | null>,
  options: PollOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() >= deadline) {
      throw new Error(`pollUntil: timed out after ${String(options.timeoutMs)}ms`);
    }
    await sleep(options.intervalMs);
  }
}

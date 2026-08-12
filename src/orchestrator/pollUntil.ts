export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * MVP §13.5: the primary fill-detection channel is the user-data-stream
 * (Slice 11); this is the fallback-poll mechanism used standalone for this
 * thin slice, since websocket wiring isn't built yet.
 */
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

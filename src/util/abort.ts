/** Adapts an AbortSignal into a Promise that resolves on abort (or immediately, if already aborted) — one race arm alongside `sleep` for interruptible polling loops. */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

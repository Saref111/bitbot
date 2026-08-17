import { describe, expect, it } from 'vitest';
import { waitForAbort } from '../../src/util/abort.js';

describe('waitForAbort', () => {
  it('resolves immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAbort(controller.signal)).resolves.toBeUndefined();
  });

  it('resolves once the signal is aborted later', async () => {
    const controller = new AbortController();
    let resolved = false;
    const promise = waitForAbort(controller.signal).then(() => {
      resolved = true;
    });

    // Not yet aborted — must not have resolved.
    await Promise.resolve();
    expect(resolved).toBe(false);

    controller.abort();
    await promise;
    expect(resolved).toBe(true);
  });

  it('never resolves if the signal is never aborted (race against a timeout stand-in)', async () => {
    const controller = new AbortController();
    let resolved = false;
    void waitForAbort(controller.signal).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
  });
});

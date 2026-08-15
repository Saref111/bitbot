import { describe, expect, it } from 'vitest';
import { createNoopNotifier } from '../../src/notify/noopNotifier.js';

describe('createNoopNotifier', () => {
  it('resolves without doing anything observable', async () => {
    const notifier = createNoopNotifier();
    await expect(notifier.notify('anything')).resolves.toBeUndefined();
  });
});

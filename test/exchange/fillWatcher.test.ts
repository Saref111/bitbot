import { describe, expect, it, vi } from 'vitest';
import { createBinanceFillWatcher } from '../../src/exchange/fillWatcher.js';

describe('createBinanceFillWatcher — MVP §13.5', () => {
  it('resolves once watchOrders resolves, passing the symbol through', async () => {
    const watchOrders = vi.fn().mockResolvedValue([{ id: '1' }]);
    const watcher = createBinanceFillWatcher({ watchOrders });

    await watcher.next('ETH/USDT:USDT');

    expect(watchOrders).toHaveBeenCalledWith('ETH/USDT:USDT');
  });

  it('propagates a rejection from watchOrders unchanged (caller decides how to degrade)', async () => {
    const watchOrders = vi.fn().mockRejectedValue(new Error('connection dropped'));
    const watcher = createBinanceFillWatcher({ watchOrders });

    await expect(watcher.next('ETH/USDT:USDT')).rejects.toThrow('connection dropped');
  });
});

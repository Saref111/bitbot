import { describe, expect, it, vi } from 'vitest';
import { pollUntil } from '../../src/orchestrator/pollUntil.js';

describe('pollUntil', () => {
  it('returns immediately when the first check already succeeds', async () => {
    const check = vi.fn().mockResolvedValue('done');
    const result = await pollUntil(check, { intervalMs: 1, timeoutMs: 1000 });
    expect(result).toBe('done');
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('retries until check returns a non-null value', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('found');

    const result = await pollUntil(check, { intervalMs: 1, timeoutMs: 1000 });

    expect(result).toBe('found');
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('throws once timeoutMs elapses without a successful check', async () => {
    const check = vi.fn().mockResolvedValue(null);
    await expect(pollUntil(check, { intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

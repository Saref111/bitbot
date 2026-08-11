import { describe, expect, it } from 'vitest';
import { requireAt } from '../../src/util/arrays.js';

describe('requireAt', () => {
  it('returns the value at a valid index', () => {
    expect(requireAt([10, 20, 30], 1)).toBe(20);
  });

  it('throws when the index is out of bounds', () => {
    expect(() => requireAt([10, 20, 30], 5)).toThrow(/out of bounds/);
  });

  it('throws on a negative index', () => {
    expect(() => requireAt([10, 20, 30], -1)).toThrow(/out of bounds/);
  });
});

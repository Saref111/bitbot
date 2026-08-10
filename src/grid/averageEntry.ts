import type { Fill } from './types.js';

export function averageEntry(fills: Fill[]): number {
  if (fills.length === 0) {
    throw new Error('averageEntry: at least one fill is required');
  }

  let totalNotional = 0;
  let totalSize = 0;
  for (const fill of fills) {
    totalNotional += fill.price * fill.size;
    totalSize += fill.size;
  }

  return totalNotional / totalSize;
}

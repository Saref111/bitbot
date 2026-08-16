/**
 * Thrown by ExchangeAdapter.cancelOrder when the order is already gone
 * (filled or otherwise resolved) rather than still cancellable — TP/SL
 * reprice treats this as "it just filled," not a real failure.
 */
export class OrderNotFoundError extends Error {}

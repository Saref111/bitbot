import type { Notifier } from './types.js';

/** Default for OrchestratorContext.notifier when Telegram isn't configured (MVP: notifications are optional). */
export function createNoopNotifier(): Notifier {
  return {
    async notify(): Promise<void> {
      // intentionally does nothing
    },
  };
}

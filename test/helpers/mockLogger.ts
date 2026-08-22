import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Logger } from '../../src/logging/logger.js';

export interface MockLoggerHandle {
  /** Pass this into the function under test — behaves like a real pino logger's .child() chain. */
  logger: Logger;
  /**
   * Assert against these regardless of how many .child() hops happened
   * downstream (Sprint 3 Task H binds exactly once, at runDeal/recoverDeal/
   * adoptExistingPosition) — every call, from any descendant, ends up here
   * with its bound fields merged in, exactly like real pino.
   */
  spies: { debug: Mock; info: Mock; warn: Mock; error: Mock };
  /** Records every .child(bindings) call anywhere in the tree — assert call count/args to catch double-binding (Sprint 3 Task H AC: exactly one bind per deal lifecycle). */
  childSpy: Mock;
}

/**
 * A pino-shaped mock whose .child(bindings) actually merges bindings into
 * every subsequent log call's data object — unlike a flat
 * `{ warn: vi.fn(), ... }` stub, this lets tests verify that a field bound
 * once via .child (e.g. dealId, Sprint 3 Task H) really does show up on
 * every downstream log line, not just that .child was called.
 */
export function createMockLogger(): MockLoggerHandle {
  const spies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const childSpy = vi.fn();

  function build(bindings: Record<string, unknown>): Logger {
    const call =
      (spy: Mock) =>
      (...args: unknown[]): void => {
        if (Object.keys(bindings).length === 0) {
          spy(...args);
          return;
        }
        const [first, ...rest] = args;
        if (typeof first === 'object' && first !== null) {
          spy({ ...bindings, ...first }, ...rest);
          return;
        }
        spy(bindings, ...args); // e.g. logger.info('msg') -> spy({...bindings}, 'msg')
      };

    return {
      debug: call(spies.debug),
      info: call(spies.info),
      warn: call(spies.warn),
      error: call(spies.error),
      child: (childBindings: Record<string, unknown>) => {
        childSpy(childBindings);
        return build({ ...bindings, ...childBindings });
      },
    } as unknown as Logger;
  }

  return { logger: build({}), spies, childSpy };
}

import type { ProcessBoundary, ShutdownSignal } from "../types";

/** The slice of Node's `process` this ring touches — narrowed so tests can pass a double. */
export interface SignalTarget {
  once(signal: ShutdownSignal, handler: () => void): unknown;
}

/**
 * The real process seam. Signals are registered with `once` because shutdown is idempotent
 * anyway (`runApp` shares one teardown promise), and a repeated Ctrl+C should reach the
 * default handler rather than queue another unmount.
 */
export function createProcessBoundary(target: SignalTarget): ProcessBoundary {
  return {
    onSignal(signal, handler) {
      target.once(signal, handler);
    },
    reportFatal(message, cause) {
      console.error(`termcraft: ${message}`);
      if (cause !== undefined && cause !== null) console.error(cause);
    },
  };
}

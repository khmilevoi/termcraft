import type { ProcessBoundary, ShutdownSignal } from "../types";

/** The two process-level panic events (M9, design §9) — an escaping failure that never went
 *  through the errore return-value contract, caught here as the very last resort. */
export type PanicEvent = "uncaughtException" | "unhandledRejection";

/** The slice of Node's `process` this ring touches — narrowed so tests can pass a double. */
export interface SignalTarget {
  once(event: ShutdownSignal | PanicEvent, handler: (error: unknown) => void): unknown;
}

/**
 * The terminal-teardown seam `restoreTerminal` drives (M9, design §9) — narrowed so tests can
 * pass a recording double standing in for the real renderer/terminal. Each method is one of
 * the three states OpenTUI's `CliRenderer` puts the terminal into at mount and normally
 * reverses itself in `destroy()` (`ui/app/model/root.tsx`'s `UiRootRenderer.destroy`): raw
 * input mode, xterm mouse-tracking, and the alternate screen buffer. A panic that never
 * reaches that `destroy()` call — an escaping throw, per M9's own gap — needs the exact same
 * three reversed independently of whether the renderer object is still reachable at all.
 */
export interface TerminalControl {
  disableRawMode(): void;
  disableMouseCapture(): void;
  exitAlternateScreen(): void;
}

/** xterm mouse-tracking modes OpenTUI enables (button-event 1000, cell-motion 1002, any-motion
 *  1003, SGR encoding 1006) — disabled in the same combination, independent of which subset is
 *  actually live, since sending an "off" for a mode that was never on is a no-op. */
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
/** Leaves the alternate screen buffer (xterm private mode 1049), restoring the operator's
 *  original scrollback and cursor position. */
const EXIT_ALTERNATE_SCREEN = "\x1b[?1049l";

/** The real terminal seam: Node/Bun's own `process.stdin`/`process.stdout`, matching every
 *  other executable root's direct use of the global `process` (`src/main.tsx`, `src/demo.tsx`). */
const REAL_TERMINAL_CONTROL: TerminalControl = {
  disableRawMode() {
    process.stdin.setRawMode?.(false);
  },
  disableMouseCapture() {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
  },
  exitAlternateScreen() {
    process.stdout.write(EXIT_ALTERNATE_SCREEN);
  },
};

/**
 * The real process seam. Signals are registered with `once` because shutdown is idempotent
 * anyway (`runApp` shares one teardown promise), and a repeated Ctrl+C should reach the
 * default handler rather than queue another unmount.
 *
 * M9: also registers a last-resort `uncaughtException`/`unhandledRejection` handler at
 * construction — a failure that escapes the errore return-value contract entirely (never
 * converted to an `Error` some caller's `instanceof Error` branch reports) would otherwise
 * leave the terminal in raw mode, mouse tracking on, and the alternate screen active (design
 * §9's own gap). Both panic events, and every `reportFatal` call reached through the normal
 * error-value path, now share ONE idempotent `restoreTerminal()` that always runs first — so
 * the terminal is sane again before anything is printed, on every exit path, not just the ones
 * `run-app.ts`'s own shutdown sequence already covers.
 */
export function createProcessBoundary(
  target: SignalTarget,
  terminal: TerminalControl = REAL_TERMINAL_CONTROL,
): ProcessBoundary {
  let restored = false;
  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    terminal.disableRawMode();
    terminal.disableMouseCapture();
    terminal.exitAlternateScreen();
  }

  function reportFatal(message: string, cause: unknown): void {
    restoreTerminal();
    console.error(`termcraft: ${message}`);
    if (cause !== undefined && cause !== null) console.error(cause);
  }

  function onPanic(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    reportFatal(`unrecoverable failure: ${message}`, error);
  }

  target.once("uncaughtException", onPanic);
  target.once("unhandledRejection", onPanic);

  return {
    onSignal(signal, handler) {
      target.once(signal, handler);
    },
    reportFatal,
  };
}

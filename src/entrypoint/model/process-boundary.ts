import { resumeConsolePassthrough } from "infrastructure/debug-log";

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

/**
 * The real process-termination seam (M9). Restoring the terminal and printing is not enough on
 * a panic: Bun does NOT auto-exit once an `uncaughtException`/`unhandledRejection` handler
 * returns (confirmed empirically — a pending timer keeps the process alive), so without an
 * explicit exit the process hangs, the still-live OpenTUI `CliRenderer`'s next paint frame can
 * re-enter raw mode / mouse tracking / alt-screen right after `restoreTerminal()` just reversed
 * them, and the project lease plus any host children (the Windows Job Object's kill-on-close
 * limit, `infrastructure/process/model/job-object.ts`) stay held until *some* process exit
 * happens. Narrowed to `(code: number) => void`, mirroring `TerminalControl`, so a test can pass
 * a recording double instead of ending the test runner.
 */
export interface ProcessExit {
  (code: number): void;
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
 * The real exit seam: flushes `stderr` before exiting, mirroring `main.tsx`'s own
 * flush-then-exit pattern for `stdout` — an empty trailing write's callback fires only after
 * every earlier write's callback already has (Writable streams process queued writes strictly
 * in order), so this guarantees the diagnostic `reportFatal` just printed via `console.error`
 * (which targets `stderr`) physically lands before the process disappears, even on a piped,
 * non-TTY `stderr` (worse on Windows).
 */
const REAL_PROCESS_EXIT: ProcessExit = (code) => {
  process.stderr.write(new Uint8Array(0), () => process.exit(code));
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
 *
 * A panic additionally terminates the process (via `exit`) once it has restored and reported.
 * Every EXPLICIT `reportFatal` call site that also needs to end the process should go through
 * the `reportFatalAndExit` method below instead of owning a bare `process.exit` of its own —
 * `main.tsx`'s `_host`-stdio-failure and interactive-bootstrap-failure branches both now call
 * it, so their exit shares the exact same flush-then-exit `exit` seam the panic path already
 * used (a bare `process.exit()` right after `reportFatal`'s `console.error` does not wait for
 * that write to physically land on a piped, non-TTY stderr — worse on Windows — so the
 * diagnostic could get truncated). `demo.tsx` still pairs its own `reportFatal` with a bare
 * `process.exit(1)` — same latent truncation risk, left alone here since `demo.tsx` is outside
 * this fix's scope.
 */
export function createProcessBoundary(
  target: SignalTarget,
  terminal: TerminalControl = REAL_TERMINAL_CONTROL,
  exit: ProcessExit = REAL_PROCESS_EXIT,
): ProcessBoundary & {
  /** `reportFatal` followed by the same `exit` seam the panic path (`onPanic`) uses — the
   *  flush-then-exit shape callers need instead of a bare `process.exit` right after
   *  `reportFatal` returns. Exit code is fixed at 1, mirroring `onPanic`'s own fixed code:
   *  every caller of this method is reporting a startup/protocol failure, never a graceful
   *  shutdown. Widens `ProcessBoundary`'s own return type rather than changing the shared
   *  interface in `../types.ts`, since only fatal-exit call sites need it. */
  reportFatalAndExit(message: string, cause: unknown): void;
} {
  let restored = false;
  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    terminal.disableRawMode();
    terminal.disableMouseCapture();
    terminal.exitAlternateScreen();
    // The fourth thing a live renderer took, and the one `TerminalControl` cannot express: while
    // it owned the terminal, `ui/app/model/root.tsx` had the debug-log tee stop calling through
    // to the real writer, so nothing would paint raw text over a frame
    // (`infrastructure/debug-log`'s `suspendConsolePassthrough`). A panic never reaches that
    // renderer's own `dispose()` — this function is the ONLY thing that runs — so without this
    // line `reportFatal`'s `console.error` below would land in the trace file and nowhere else,
    // leaving the operator with a correctly restored but completely blank terminal. Called
    // directly rather than through the injected `terminal` seam precisely because it must never
    // be optional: `main.tsx`'s `NOOP_TERMINAL_CONTROL` (the `_host`/`export` branches, which
    // never suspend anything) would otherwise be free to omit it. Idempotent, and a no-op in
    // every process that never suspended.
    resumeConsolePassthrough();
  }

  function reportFatal(message: string, cause: unknown): void {
    restoreTerminal();
    console.error(`termcraft: ${message}`);
    if (cause !== undefined && cause !== null) console.error(cause);
  }

  function reportFatalAndExit(message: string, cause: unknown): void {
    reportFatal(message, cause);
    // Same reasoning as `onPanic` below: `reportFatal` only prints (via `console.error`), it
    // never exits, so callers that need to end the process route through the injected `exit`
    // seam themselves — `REAL_PROCESS_EXIT` by default, which flushes `stderr` before exiting.
    exit(1);
  }

  function onPanic(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    reportFatal(`unrecoverable failure: ${message}`, error);
    // Restore is synchronous (it runs entirely inside `reportFatal`, above), so by the time
    // `exit` is called the terminal is already sane — exiting only stops the still-live
    // renderer from re-corrupting it and releases the OS-level project lease/host children.
    exit(1);
  }

  target.once("uncaughtException", onPanic);
  target.once("unhandledRejection", onPanic);

  return {
    onSignal(signal, handler) {
      target.once(signal, handler);
    },
    reportFatal,
    reportFatalAndExit,
  };
}

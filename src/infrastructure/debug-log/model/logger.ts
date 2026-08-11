import type { TeeSink } from "../types";
import { trace, traceEnabled } from "./sink";

/**
 * DIAGNOSTIC INSTRUMENTATION — see `sink.ts`'s header.
 *
 * REPLACES THE FORMER `console-tee.ts` (2026-08-10). That module monkey-patched
 * `console.log/info/warn/error/debug` so the ~360 existing `console.*` call sites across the
 * codebase would keep working unmodified while still reaching the trace file and staying off the
 * live frame. Every call site now calls `log.*` here directly instead — nothing overwrites the
 * global `console` object anymore, which removes an entire class of failure this module used to
 * guard against on its own (a foreign re-override stomping the wrapper, the wrapper's writer
 * capture going stale, `installConsoleTee`'s idempotent-by-identity bookkeeping). `console.*`
 * itself is untouched; anything that still calls it directly (a dependency, a test's own
 * assertion) behaves exactly as it always did.
 *
 * WHY THE SUSPEND/HOLD MACHINERY SURVIVES UNCHANGED. The interactive shell still owns the
 * terminal (raw mode + alternate screen) for the run's whole lifetime, and a stray write during
 * that window still corrupts the live frame — that fact did not depend on monkey-patching, only
 * on some call reaching a real writer while the renderer owns the screen. `suspendConsolePassthrough`/
 * `resumeConsolePassthrough` gate `log.*` the same way they gated the old wrapper: while
 * suspended, a captured sink gets the line and nothing else; an uncaptured line is held in the
 * same bounded ring buffer and flushed once the terminal is handed back.
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const defaultSink: TeeSink = { enabled: traceEnabled, trace };

/**
 * Whether `log.*` calls still reach the real `console`. See {@link suspendConsolePassthrough}.
 * Module-level because there is exactly one terminal per process, so there is exactly one answer
 * to "may anything write to it right now".
 */
let passthrough = true;

/**
 * How many suppressed lines the hold buffer keeps when no trace sink is capturing them.
 *
 * Bounded because an unbounded one is a leak: an entry pins its raw `args` — whole `Error` cause
 * chains, whole payload objects — alive for the renderer's entire lifetime, which in this app is
 * the whole session. 200 covers the diagnostics a session actually emits while staying small
 * enough that the retention does not matter. Raw args rather than eagerly formatted strings
 * because formatting is Node's job and doing it here would change what the operator finally
 * reads. On overflow the OLDEST entry falls out and {@link resumeConsolePassthrough}'s flush
 * announces the count — dropping silently would be the same class of defect this module exists
 * to undo.
 */
export const MAX_HELD_LINES = 200;

interface HeldLine {
  readonly method: ConsoleMethod;
  readonly args: readonly unknown[];
}

const held: HeldLine[] = [];
let droppedWhileHeld = 0;

/**
 * The pre-bridge `console` methods, captured at install time.
 *
 * WHY AN INDIRECTION AT ALL. `installThirdPartyConsoleBridge` replaces `console.warn` with a
 * call into `emit`, and `emit`'s passthrough branch writes to `console`. Without this capture
 * that is an infinite loop. With it, a bridged passthrough writes to the function the bridge
 * replaced, and an UNBRIDGED passthrough still writes to whatever `console[method]` currently
 * is — which is what keeps every test that `spyOn(console, …)` working exactly as before.
 */
let bridged: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> | null = null;

const CONSOLE_METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

function writeThrough(method: ConsoleMethod, args: readonly unknown[]): void {
  const captured = bridged?.[method];
  if (captured !== undefined) {
    captured(...args);
    return;
  }
  console[method](...args);
}

/**
 * Route a DEPENDENCY's own `console.*` calls into `log.*`.
 *
 * WHY THIS EXISTS. `@opentui/core` reports highlight failures with
 * `console.warn("Code highlighting failed, falling back to plain text:", error)` and its
 * `TreeSitterClient` reports worker/init failures with `console.error`. Under
 * `consoleMode: "disabled"` OpenTUI does not silence those — `TerminalConsoleCache.deactivate()`
 * RESTORES the real console — so they write to real stdout. In the interactive shell that
 * corrupts the frame; in the `_host --stdio` child, whose stdout IS the protocol pipe, it
 * corrupts framing. termcraft's own call sites already report through `log.*`; this closes the
 * one hole left, for code termcraft does not own.
 *
 * DELIBERATELY NOT THE OLD GLOBAL TEE. This is installed by the two processes that own a byte
 * stream and by nothing else, it is uninstalled when they hand the stream back, and it is never
 * installed under `bun test` unless a test installs it. Idempotent by identity: a second call
 * while installed is a no-op, so the bridge can never chain onto itself.
 */
export function installThirdPartyConsoleBridge(): void {
  if (bridged !== null) return;
  const captured: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
  for (const method of CONSOLE_METHODS) {
    captured[method] = console[method].bind(console) as (...args: unknown[]) => void;
  }
  bridged = captured;
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => emit(method, defaultSink, args);
  }
}

/** Hand `console` back exactly as it was at install. Idempotent, and safe when never installed. */
export function uninstallThirdPartyConsoleBridge(): void {
  const captured = bridged;
  if (captured === null) return;
  bridged = null;
  for (const method of CONSOLE_METHODS) {
    const original = captured[method];
    if (original !== undefined) console[method] = original;
  }
}

/**
 * Stop `log.*` from reaching `console`; keep mirroring into the sink. Call this the moment a
 * renderer takes the terminal, and pair it with {@link resumeConsolePassthrough}.
 *
 * WHAT HAPPENS TO A LINE WHILE THIS IS IN EFFECT. When a sink is capturing, the trace file has
 * it and there is nothing further to do. When one is NOT — `TERMCRAFT_DEBUG_LOG=0|off|false`, or
 * a `bun test` process — the line goes into the bounded hold buffer and reaches `console` the
 * moment {@link resumeConsolePassthrough} runs. Neither branch discards anything, which is what
 * makes this safe to engage unconditionally.
 *
 * WHAT IT DOES NOT COVER. This gates `log.*` only. A direct `console.*` call, a
 * `process.stderr.write`, `process.emitWarning`, and the runtime's own uncaught-exception printer
 * all bypass it and can still reach the screen. That is deliberate and safe for the fatal paths —
 * nothing there is swallowed — but "the screen is not written to" is true of this module's
 * traffic, not of the process as a whole.
 */
export function suspendConsolePassthrough(): void {
  passthrough = false;
}

/**
 * Hand the writer back, and release anything held while it was gone. Idempotent, and safe when
 * nothing was ever suspended.
 *
 * Every path that gives the terminal back must call this, not just the tidy one: the renderer's
 * own teardown (`ui/app/model/render-root.tsx`'s `dispose`, its failure branches, and the
 * renderer that never came up) AND `entrypoint/model/process-boundary.ts`'s `restoreTerminal`,
 * which is the only thing that runs on a panic — `reportFatal` writes right after it, and a fatal
 * message swallowed into the trace file leaves the operator staring at a blank terminal.
 */
export function resumeConsolePassthrough(): void {
  // FIRST, before the flush: a flush that ran with the gate still down would hold its own output
  // straight back into the buffer.
  passthrough = true;
  flushHeld();
}

function flushHeld(): void {
  if (held.length === 0 && droppedWhileHeld === 0) return;
  const lines = held.splice(0);
  const dropped = droppedWhileHeld;
  droppedWhileHeld = 0;

  // Ahead of the survivors, because the dropped ones were the oldest — this reads in the order
  // the lines happened.
  if (dropped > 0) {
    writeThrough("error", [
      `termcraft: ${dropped} earlier log line(s) were dropped while the terminal was held (the buffer keeps the most recent ${MAX_HELD_LINES})`,
    ]);
  }
  for (const line of lines) writeThrough(line.method, line.args);
}

function hold(method: ConsoleMethod, args: readonly unknown[]): void {
  if (held.length >= MAX_HELD_LINES) {
    held.shift();
    droppedWhileHeld++;
  }
  held.push({ method, args });
}

/**
 * Errors are flattened here rather than in the sink's replacer so a `cause` chain — errore's
 * primary debugging affordance — survives into the trace instead of collapsing to a message.
 */
function describe(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: value.cause === undefined ? undefined : describe(value.cause),
    };
  }
  return value;
}

function emit(method: ConsoleMethod, sink: TeeSink, args: readonly unknown[]): void {
  const captured = sink.enabled();
  if (captured) sink.trace(`console.${method}`, { args: args.map(describe) });
  if (passthrough) {
    writeThrough(method, args);
    return;
  }
  if (captured) return;
  hold(method, args);
}

interface Logger {
  readonly log: (...args: unknown[]) => void;
  readonly info: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
  readonly error: (...args: unknown[]) => void;
  readonly debug: (...args: unknown[]) => void;
}

function loggerFor(sink: TeeSink): Logger {
  return {
    log: (...args) => emit("log", sink, args),
    info: (...args) => emit("info", sink, args),
    warn: (...args) => emit("warn", sink, args),
    error: (...args) => emit("error", sink, args),
    debug: (...args) => emit("debug", sink, args),
  };
}

/**
 * The call sites' entry point. Every former `console.*` call in the app now calls the matching
 * method here instead — same signature, same five methods, so the replacement was mechanical.
 */
export const log: Logger = loggerFor(defaultSink);

/** Test-only seam: builds a `log`-shaped object wired to an injected sink instead of the real one. */
export function createLogger(sink: TeeSink): Logger {
  return loggerFor(sink);
}

import type { TeeSink } from "../types";
import { trace, traceEnabled } from "./sink";

/**
 * DIAGNOSTIC INSTRUMENTATION — see `sink.ts`'s header.
 *
 * The codebase already reports through `console.warn`/`console.error`/`console.log` from 82
 * non-test files, and in a live interactive run every one of those lines is lost behind the
 * alternate screen. Rather than edit hundreds of call sites, this mirrors them into the trace file.
 *
 * THE ORIGINAL METHOD IS NOT ALWAYS CALLED (2026-07-28). This used to say that it always was,
 * and that the tee could therefore be removed without altering what the app does. Neither is
 * true anymore. While {@link suspendConsolePassthrough} is in effect — for exactly as long as
 * the interactive renderer owns the terminal — the wrapper does NOT call the writer it replaced,
 * because with `consoleMode: "disabled"` that writer is the real terminal and one call paints
 * raw text over a live frame. Nothing is lost either way: the line goes to the trace file, or,
 * when no file is capturing, into the bounded hold buffer below and out to the writer the
 * moment the terminal is handed back. Removing this module now would restore the frame tearing,
 * so it is load-bearing, not merely diagnostic.
 *
 * IDEMPOTENT BY WRAPPER IDENTITY, NOT BY A FLAG (2026-07-27, HANDOFF Finding 1). The old
 * `installed` boolean made the SECOND install a no-op — which is precisely wrong, because
 * `@opentui/core`'s `overrideConsoleMethods` (`chunk-bun-tkm837n2.js:4480`) replaces
 * `console.log/info/warn/error/debug` wholesale AFTER this runs and never calls through, so the
 * interactive process traced nothing from the moment its renderer started. Keying on "is
 * `console[method]` still the wrapper WE installed" makes a re-install a no-op when nothing
 * replaced us and a genuine repair when something did. `info` and `debug` are covered too:
 * OpenTUI overrides them, so leaving them out left two silent channels.
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
type ConsoleWriter = (...args: unknown[]) => void;

const METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

/** The wrapper this module last installed per method — the identity a re-install compares against. */
const installedWrappers = new Map<ConsoleMethod, unknown>();

/** The writer each wrapper replaced. A held line is flushed straight through this map, never
 *  back through `console`, so a flush can never re-enter the gate it was released by. */
const installedOriginals = new Map<ConsoleMethod, ConsoleWriter>();

const defaultSink: TeeSink = { enabled: traceEnabled, trace };

/**
 * Whether the wrappers still call the writer they replaced. See {@link suspendConsolePassthrough}.
 * Module-level because `console` is: there is exactly one console per process, so there is
 * exactly one answer to "may anything write to the terminal right now".
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
 *
 * The cost of holding raw args is that they are read at FLUSH time, not at call time: an object
 * mutated between the `console.*` call and the flush prints the value it holds then, not the one
 * the call site meant to report. Accepted as the lesser evil against eager formatting, and
 * invisible whenever a trace sink is capturing — that path serialises immediately and never
 * holds anything.
 */
export const MAX_HELD_LINES = 200;

interface HeldLine {
  readonly method: ConsoleMethod;
  readonly args: readonly unknown[];
}

const held: HeldLine[] = [];
let droppedWhileHeld = 0;

/**
 * Stop calling the underlying writer; keep mirroring into the sink. Call this the moment a
 * renderer takes the terminal, and pair it with {@link resumeConsolePassthrough}.
 *
 * WHY THIS EXISTS (2026-07-28). `ui/app/model/root.tsx` runs the interactive renderer with
 * `consoleMode: "disabled"`, which is correct — OpenTUI's default `"console-overlay"` replaces
 * every `console.*` method with an overlay writer that never calls through, destroying this tee.
 * But `"disabled"` means OpenTUI installs NO interceptor at all, so the writer this tee captured
 * as `original` is the real one: `@opentui/core`'s `createCliRenderer` defaults `stdout` to
 * `process.stdout` (`chunk-bun-tkm837n2.js:6889`), the default `screenMode` is
 * `"alternate-screen"` and therefore `externalOutputMode` resolves to `"passthrough"`
 * (`:6659`/`:6664`), which restores `stdout.write` to the untouched writer (`:7307`) — and
 * `console.warn`/`console.error` go to `stderr`, which the renderer never touches at all. A
 * single `console.warn` during a live frame therefore paints raw text over the rendered UI,
 * which is exactly what a live run's screenshot showed.
 *
 * WHAT HAPPENS TO A LINE WHILE THIS IS IN EFFECT. When a sink is capturing, the trace file has
 * it and there is nothing further to do. When one is NOT — `TERMCRAFT_DEBUG_LOG=0|off|false`, or
 * a `bun test` process — the line goes into the bounded hold buffer and reaches the writer the
 * moment {@link resumeConsolePassthrough} runs. Neither branch discards anything, which is what
 * makes this safe to engage unconditionally; an earlier version left the tee uninstalled when
 * tracing was off, which meant there was no gate at all and the frame tore exactly as before.
 *
 * WHAT IT DOES NOT COVER. This gates `console.*` only. A direct `process.stderr.write`, a
 * `process.emitWarning`, and the runtime's own uncaught-exception printer all bypass it and can
 * still reach the screen. That is deliberate and safe for the fatal paths — nothing there is
 * swallowed — but "the screen is not written to" is true of this module's traffic, not of the
 * process as a whole.
 */
export function suspendConsolePassthrough(): void {
  passthrough = false;
}

/**
 * Hand the writer back, and release anything held while it was gone. Idempotent, and safe when
 * nothing was ever suspended.
 *
 * Every path that gives the terminal back must call this, not just the tidy one: the renderer's
 * own teardown (`ui/app/model/root.tsx`'s `dispose`, its failure branches, and the renderer that
 * never came up) AND `entrypoint/model/process-boundary.ts`'s `restoreTerminal`, which is the
 * only thing that runs on a panic — `reportFatal` prints through `console.error` right after it,
 * and a fatal message swallowed into the trace file leaves the operator staring at a blank
 * terminal.
 */
export function resumeConsolePassthrough(): void {
  // FIRST, before the flush: a flush that ran with the gate still down would hold its own output
  // straight back into the buffer. (It writes through `installedOriginals` rather than `console`
  // as well, so it cannot re-enter the wrapper at all — two independent guards, because getting
  // this wrong loses the very lines the buffer exists to save.)
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
    writerFor("error")(
      `termcraft: ${dropped} earlier console line(s) were dropped while the terminal was held (the buffer keeps the most recent ${MAX_HELD_LINES})`,
    );
  }
  for (const line of lines) writerFor(line.method)(...line.args);
}

/**
 * The writer a held line is released through — total, never optional.
 *
 * {@link installConsoleTee} fills all five originals in one loop, so the fallback is unreachable
 * today. It is still written out rather than left as a `?.` because both call sites above exist
 * precisely to guarantee that nothing is discarded in silence, and an optional call makes the
 * one thing that must not be skippable exactly that. A missing original would silently swallow a
 * held line — and, worse, the announcement that lines had been swallowed.
 */
function writerFor(method: ConsoleMethod): ConsoleWriter {
  const original = installedOriginals.get(method);
  if (original !== undefined) return original;
  // Reached only if the invariant above ever breaks. `passthrough` is already true by the time a
  // flush runs, so going back through `console` calls through to the real writer rather than
  // re-entering the hold path.
  return console[method].bind(console);
}

function hold(method: ConsoleMethod, args: readonly unknown[]): void {
  if (held.length >= MAX_HELD_LINES) {
    held.shift();
    droppedWhileHeld++;
  }
  held.push({ method, args });
}

/**
 * Install (or re-install) the tee. Safe to call at any point in the process's life.
 *
 * Installs even when the sink is disabled (2026-07-28): the wrapper is what
 * {@link suspendConsolePassthrough} gates, so skipping it when tracing is off left the reported
 * frame-tearing bug live under a supported configuration. A disabled sink is never called and
 * never has a payload built for it, so the tee stays transparent — same output, one extra call
 * frame per `console.*`.
 */
export function installConsoleTee(sink: TeeSink = defaultSink): void {
  for (const method of METHODS) {
    if ((console[method] as unknown) === installedWrappers.get(method)) continue;
    const original = console[method].bind(console);
    const wrapper = (...args: unknown[]): void => {
      // Resolved per call, not per install: tracing can be off at install time and the wrapper
      // still has to behave correctly for the whole process's life.
      const captured = sink.enabled();
      if (captured) sink.trace(`console.${method}`, { args: args.map(describe) });
      // Read at call time, never captured: a re-install that repairs a foreign override must
      // not hand the terminal back to a renderer that still owns it.
      if (passthrough) {
        original(...args);
        return;
      }
      if (captured) return;
      hold(method, args);
    };
    console[method] = wrapper;
    installedWrappers.set(method, wrapper);
    installedOriginals.set(method, original);
  }
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

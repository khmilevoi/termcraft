import type { TeeSink } from "../types";
import { trace, traceEnabled } from "./sink";

/**
 * DIAGNOSTIC INSTRUMENTATION — see `sink.ts`'s header.
 *
 * The codebase already reports through `console.warn`/`console.error`/`console.log` from 75
 * files, and in a live interactive run every one of those lines is lost behind the alternate
 * screen. Rather than edit hundreds of call sites, this mirrors them into the trace file.
 *
 * The original methods are still called, so behavior is unchanged and this can be left in place
 * or removed without altering what the app does.
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

const METHODS: readonly ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

/** The wrapper this module last installed per method — the identity a re-install compares against. */
const installedWrappers = new Map<ConsoleMethod, unknown>();

const defaultSink: TeeSink = { enabled: traceEnabled, trace };

/**
 * Whether the wrappers still call the writer they replaced. See {@link suspendConsolePassthrough}.
 * Module-level because `console` is: there is exactly one console per process, so there is
 * exactly one answer to "may anything write to the terminal right now".
 */
let passthrough = true;

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
 * Deliberately inert when tracing is off: {@link installConsoleTee} installs nothing then, so
 * there are no wrappers to gate and the flag has no effect. That is the intended trade — with
 * no file capturing the line, discarding it would be strictly worse than a torn frame, because
 * a torn frame is at least visible.
 */
export function suspendConsolePassthrough(): void {
  passthrough = false;
}

/**
 * Hand the writer back. Idempotent, and safe when nothing was ever suspended.
 *
 * Every path that gives the terminal back must call this, not just the tidy one: the renderer's
 * own teardown (`ui/app/model/root.tsx`'s `dispose`, and its two mount-failure branches) AND
 * `entrypoint/model/process-boundary.ts`'s `restoreTerminal`, which is the only thing that runs
 * on a panic — `reportFatal` prints through `console.error` right after it, and a fatal message
 * swallowed into the trace file leaves the operator staring at a blank terminal.
 */
export function resumeConsolePassthrough(): void {
  passthrough = true;
}

/** Install (or re-install) the tee. Safe to call at any point in the process's life. */
export function installConsoleTee(sink: TeeSink = defaultSink): void {
  if (!sink.enabled()) return;

  for (const method of METHODS) {
    if ((console[method] as unknown) === installedWrappers.get(method)) continue;
    const original = console[method].bind(console);
    const wrapper = (...args: unknown[]): void => {
      sink.trace(`console.${method}`, { args: args.map(describe) });
      // Read at call time, never captured: a re-install that repairs a foreign override must
      // not hand the terminal back to a renderer that still owns it.
      if (passthrough) original(...args);
    };
    console[method] = wrapper;
    installedWrappers.set(method, wrapper);
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

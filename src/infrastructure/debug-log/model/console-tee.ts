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

/** Install (or re-install) the tee. Safe to call at any point in the process's life. */
export function installConsoleTee(sink: TeeSink = defaultSink): void {
  if (!sink.enabled()) return;

  for (const method of METHODS) {
    if ((console[method] as unknown) === installedWrappers.get(method)) continue;
    const original = console[method].bind(console);
    const wrapper = (...args: unknown[]): void => {
      sink.trace(`console.${method}`, { args: args.map(describe) });
      original(...args);
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

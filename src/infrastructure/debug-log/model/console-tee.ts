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
 */

type ConsoleMethod = "log" | "warn" | "error";

const METHODS: readonly ConsoleMethod[] = ["log", "warn", "error"];

let installed = false;

/** Idempotent: installing twice would double every recorded line. */
export function installConsoleTee(): void {
  if (installed || !traceEnabled()) return;
  installed = true;

  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      trace(`console.${method}`, { args: args.map(describe) });
      original(...args);
    };
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

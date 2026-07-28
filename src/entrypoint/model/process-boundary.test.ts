import { describe, expect, test } from "bun:test";

import {
  installConsoleTee,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
} from "infrastructure/debug-log";
import type { TeeSink } from "infrastructure/debug-log";

import type { ShutdownSignal } from "../types";
import { createProcessBoundary } from "./process-boundary";
import type { PanicEvent, ProcessExit, SignalTarget, TerminalControl } from "./process-boundary";

/** A `SignalTarget` double tracking the last handler registered per event name, so a test can
 *  fire it directly instead of dispatching a real OS signal or a real process-level panic. */
function fakeTarget(): {
  target: SignalTarget;
  handlers: Map<ShutdownSignal | PanicEvent, (error: unknown) => void>;
} {
  const handlers = new Map<ShutdownSignal | PanicEvent, (error: unknown) => void>();
  const target: SignalTarget = {
    once: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  return { target, handlers };
}

/** A `TerminalControl` double recording call order, standing in for the real renderer/terminal. */
function fakeTerminal(calls: string[]): TerminalControl {
  return {
    disableRawMode: () => calls.push("raw-mode-off"),
    disableMouseCapture: () => calls.push("mouse-off"),
    exitAlternateScreen: () => calls.push("alt-screen-off"),
  };
}

/** A `ProcessExit` double recording every call instead of ending the test runner — the panic
 *  path must terminate the process for real (M9), but a test firing that path directly cannot
 *  be allowed to call the real `process.exit`. */
function fakeExit(calls: string[]): ProcessExit {
  return (code) => calls.push(`exit:${code}`);
}

/** Runs `run` with `console.error` swapped for a recorder, always restoring the real one. */
function withCapturedConsoleError<T>(calls: string[], run: () => T): T {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(`printed:${String(args[0])}`);
  };
  try {
    return run();
  } finally {
    console.error = original;
  }
}

describe("createProcessBoundary", () => {
  test("registers each shutdown signal once on the target process", () => {
    const { target, handlers } = fakeTarget();
    const boundary = createProcessBoundary(target, fakeTerminal([]));

    boundary.onSignal("SIGINT", () => undefined);
    boundary.onSignal("SIGTERM", () => undefined);

    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
  });

  test("forwards the registered handler to the caller's callback", () => {
    const { target, handlers } = fakeTarget();
    const boundary = createProcessBoundary(target, fakeTerminal([]));

    let fired = 0;
    boundary.onSignal("SIGINT", () => fired++);
    handlers.get("SIGINT")?.(undefined);

    expect(fired).toBe(1);
  });

  test("registers a panic handler for uncaughtException and unhandledRejection at construction", () => {
    const { target, handlers } = fakeTarget();
    createProcessBoundary(target, fakeTerminal([]));

    expect(handlers.has("uncaughtException")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
  });

  test("an escaping uncaughtException restores the terminal exactly once, in order, before the failure is printed", () => {
    const { target, handlers } = fakeTarget();
    const calls: string[] = [];
    createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      handlers.get("uncaughtException")?.(new Error("boom"));
    });

    expect(calls.slice(0, 3)).toEqual(["raw-mode-off", "mouse-off", "alt-screen-off"]);
    expect(calls.length).toBeGreaterThan(3);
    const printed = calls.slice(3, -1);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.every((entry) => entry.startsWith("printed:"))).toBe(true);
  });

  test("an unhandledRejection is routed through the same restore-then-report panic path", () => {
    const { target, handlers } = fakeTarget();
    const calls: string[] = [];
    createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      handlers.get("unhandledRejection")?.("some rejection reason");
    });

    expect(calls.slice(0, 3)).toEqual(["raw-mode-off", "mouse-off", "alt-screen-off"]);
  });

  test("restoreTerminal never runs twice, even across a panic followed by an explicit reportFatal", () => {
    const { target, handlers } = fakeTarget();
    const calls: string[] = [];
    const boundary = createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      handlers.get("uncaughtException")?.(new Error("first"));
      boundary.reportFatal("second failure", null);
    });

    expect(calls.filter((entry) => entry === "raw-mode-off")).toHaveLength(1);
    expect(calls.filter((entry) => entry === "mouse-off")).toHaveLength(1);
    expect(calls.filter((entry) => entry === "alt-screen-off")).toHaveLength(1);
  });

  test("a panic terminates the process (exit code 1) after the terminal is restored and the failure printed", () => {
    const { target, handlers } = fakeTarget();
    const calls: string[] = [];
    createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      handlers.get("uncaughtException")?.(new Error("boom"));
    });

    expect(calls.at(-1)).toBe("exit:1");
    expect(calls.filter((entry) => entry.startsWith("exit:"))).toHaveLength(1);
  });

  test("an explicit reportFatal call (not a panic) never terminates the process on its own", () => {
    const { target } = fakeTarget();
    const calls: string[] = [];
    const boundary = createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      boundary.reportFatal("startup failed", null);
    });

    expect(calls.some((entry) => entry.startsWith("exit:"))).toBe(false);
  });

  test("reportFatalAndExit restores the terminal, prints the failure, then exits code 1 through the injected exit seam", () => {
    // Covers main.tsx's two explicit fatal branches (`_host`-stdio failure, interactive
    // bootstrap failure): both used to pair `reportFatal` with a bare `process.exit(1)` that
    // bypassed the injected `exit` seam entirely, so on the real process this could exit before
    // `reportFatal`'s `console.error` write physically landed on a piped, non-TTY stderr. This
    // method exists so both call sites go through the SAME `exit` seam the panic path
    // (`onPanic`, tested above) already uses.
    const { target } = fakeTarget();
    const calls: string[] = [];
    const boundary = createProcessBoundary(target, fakeTerminal(calls), fakeExit(calls));

    withCapturedConsoleError(calls, () => {
      boundary.reportFatalAndExit("startup failed", null);
    });

    expect(calls.slice(0, 3)).toEqual(["raw-mode-off", "mouse-off", "alt-screen-off"]);
    expect(calls.some((entry) => entry.startsWith("printed:"))).toBe(true);
    expect(calls.at(-1)).toBe("exit:1");
    expect(calls.filter((entry) => entry.startsWith("exit:"))).toHaveLength(1);
  });
});

/**
 * The renderer suspends the debug-log tee's console pass-through for as long as it owns the
 * terminal (`infrastructure/debug-log`'s `suspendConsolePassthrough`, engaged by
 * `ui/app/model/root.tsx`). A panic never reaches that renderer's `dispose()` — `restoreTerminal`
 * is the ONLY thing that runs — so if it did not also hand the writer back, `reportFatal`'s own
 * `console.error` would land in the trace file and the operator would be left with a restored
 * but completely blank terminal, which is a worse failure than the torn frame the suspension
 * exists to prevent.
 *
 * Asserted through the REAL tee, not a spy: the writer double is installed BEFORE the tee, so it
 * is what the tee captured as its `original`, and reaching it is the same thing as reaching the
 * terminal in production.
 */
describe("createProcessBoundary with a suspended console tee", () => {
  function withSuspendedTee(printed: string[], run: () => void): void {
    // All five, not just `error`: `installConsoleTee` wraps every method it covers, so restoring
    // only the one this suite asserts on would leave four live wrappers behind it.
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    } as const;
    console.error = (...args: unknown[]) => printed.push(String(args[0]));
    const sink: TeeSink = { enabled: () => true, trace: () => undefined };
    installConsoleTee(sink);
    suspendConsolePassthrough();
    try {
      run();
    } finally {
      resumeConsolePassthrough();
      Object.assign(console, originals);
    }
  }

  test("a panic still prints the failure to the terminal", () => {
    const { target, handlers } = fakeTarget();
    const printed: string[] = [];

    withSuspendedTee(printed, () => {
      createProcessBoundary(target, fakeTerminal([]), fakeExit([]));
      handlers.get("uncaughtException")?.(new Error("boom"));
    });

    expect(printed.some((line) => line.includes("boom"))).toBe(true);
  });

  test("an explicit reportFatal still prints the failure to the terminal", () => {
    const { target } = fakeTarget();
    const printed: string[] = [];

    withSuspendedTee(printed, () => {
      const boundary = createProcessBoundary(target, fakeTerminal([]), fakeExit([]));
      boundary.reportFatal("startup failed", null);
    });

    expect(printed).toContain("termcraft: startup failed");
  });
});

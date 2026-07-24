import { describe, expect, test } from "bun:test";

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
});

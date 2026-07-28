import { afterEach, describe, expect, test } from "bun:test";

import type { TeeSink } from "../types";
import {
  installConsoleTee,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
} from "./console-tee";

const ORIGINALS = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
} as const;

afterEach(() => {
  Object.assign(console, ORIGINALS);
  // The suspension is process-global (so is `console`), so a test that leaves it engaged would
  // silence every later test's own writer assertions in the same runner process.
  resumeConsolePassthrough();
});

function recordingSink(lines: string[]): TeeSink {
  return {
    enabled: () => true,
    trace: (channel, data) => lines.push(`${channel}:${JSON.stringify(data.args)}`),
  };
}

describe("installConsoleTee", () => {
  test("mirrors a warning into the sink and, with the terminal free, calls the original through", () => {
    const lines: string[] = [];
    const said: unknown[] = [];
    console.warn = (...args: unknown[]) => said.push(...args);

    installConsoleTee(recordingSink(lines));
    console.warn("hello");

    expect(lines).toEqual(['console.warn:["hello"]']);
    expect(said).toEqual(["hello"]);
  });

  test("re-installs over a foreign override — OpenTUI's overrideConsoleMethods", () => {
    const lines: string[] = [];
    const sink = recordingSink(lines);
    installConsoleTee(sink);

    // Exactly what `@opentui/core`'s `overrideConsoleMethods` does: assign a new function that
    // never calls the previous one. The first install's wrapper is gone at this point.
    const overlay: unknown[] = [];
    console.warn = (...args: unknown[]) => overlay.push(...args);

    installConsoleTee(sink);
    console.warn("after the renderer started");

    expect(lines).toEqual(['console.warn:["after the renderer started"]']);
    expect(overlay).toEqual(["after the renderer started"]);
  });

  test("installing twice over its own wrapper does not double-record", () => {
    const lines: string[] = [];
    const sink = recordingSink(lines);
    installConsoleTee(sink);
    installConsoleTee(sink);
    console.warn("once");

    expect(lines).toEqual(['console.warn:["once"]']);
  });

  test("covers every method OpenTUI overrides, including info and debug", () => {
    const lines: string[] = [];
    const infoSaid: unknown[] = [];
    const debugSaid: unknown[] = [];
    console.info = (...args: unknown[]) => infoSaid.push(...args);
    console.debug = (...args: unknown[]) => debugSaid.push(...args);

    installConsoleTee(recordingSink(lines));
    console.info("i");
    console.debug("d");

    expect(lines).toEqual(['console.info:["i"]', 'console.debug:["d"]']);
    expect(infoSaid).toEqual(["i"]);
    expect(debugSaid).toEqual(["d"]);
  });

  test("does nothing at all when tracing is off", () => {
    const untouched = console.warn;
    installConsoleTee({ enabled: () => false, trace: () => undefined });

    expect(console.warn).toBe(untouched);
  });

  test("flattens an Error argument with its cause chain", () => {
    const lines: string[] = [];
    const said: unknown[] = [];
    console.error = (...args: unknown[]) => said.push(...args);

    installConsoleTee(recordingSink(lines));
    const outer = new Error("outer", { cause: new Error("inner") });
    console.error("failed:", outer);

    expect(lines[0]).toContain('"message":"inner"');
    expect(said).toEqual(["failed:", outer]);
  });
});

describe("suspendConsolePassthrough", () => {
  test("keeps mirroring into the sink while never reaching the underlying writer", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    installConsoleTee(recordingSink(lines));
    suspendConsolePassthrough();
    console.warn("core/kernel/handlers/preview-export: preview.queryGeometry was failed");

    expect(lines).toEqual([
      'console.warn:["core/kernel/handlers/preview-export: preview.queryGeometry was failed"]',
    ]);
    // The regression this pins: with `consoleMode: "disabled"` the underlying writer IS the real
    // terminal, so one call through here paints raw text over the rendered frame.
    expect(screen).toEqual([]);
  });

  test("suspends every method the tee covers, not just warn", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      console[method] = (...args: unknown[]) => screen.push(...args);
    }

    installConsoleTee(recordingSink(lines));
    suspendConsolePassthrough();
    console.log("l");
    console.info("i");
    console.warn("w");
    console.error("e");
    console.debug("d");

    expect(lines).toHaveLength(5);
    expect(screen).toEqual([]);
  });

  test("survives a re-install over a foreign override", () => {
    const lines: string[] = [];
    const sink = recordingSink(lines);
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    installConsoleTee(sink);
    suspendConsolePassthrough();
    // A renderer that re-overrode console after the suspension: the repair re-install must not
    // hand the terminal back while the renderer still owns it.
    console.warn = (...args: unknown[]) => screen.push(...args);
    installConsoleTee(sink);
    console.warn("still mid-frame");

    expect(lines).toEqual(['console.warn:["still mid-frame"]']);
    expect(screen).toEqual([]);
  });

  test("is inert when tracing is off, so output is never dropped uncaptured", () => {
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    installConsoleTee({ enabled: () => false, trace: () => undefined });
    suspendConsolePassthrough();
    console.warn("nowhere else to go");

    // Deliberate: with no sink installed there is no file holding this line, and silently
    // discarding a diagnostic is strictly worse than a torn frame. A torn frame is at least
    // visible; a swallowed one is the failure mode this whole branch exists to undo.
    expect(screen).toEqual(["nowhere else to go"]);
  });
});

describe("resumeConsolePassthrough", () => {
  test("hands the writer back once the renderer has released the terminal", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.error = (...args: unknown[]) => screen.push(...args);

    installConsoleTee(recordingSink(lines));
    suspendConsolePassthrough();
    console.error("during the frame");
    resumeConsolePassthrough();
    console.error("after teardown");

    expect(screen).toEqual(["after teardown"]);
    expect(lines).toEqual([
      'console.error:["during the frame"]',
      'console.error:["after teardown"]',
    ]);
  });

  test("is idempotent and safe to call when nothing was ever suspended", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    installConsoleTee(recordingSink(lines));
    resumeConsolePassthrough();
    resumeConsolePassthrough();
    console.warn("plain");

    expect(screen).toEqual(["plain"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import type { TeeSink } from "../types";
import {
  MAX_HELD_LINES,
  createLogger,
  installThirdPartyConsoleBridge,
  log,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
  uninstallThirdPartyConsoleBridge,
} from "./logger";

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

describe("createLogger", () => {
  test("mirrors a warning into the sink and, with the terminal free, calls console through", () => {
    const lines: string[] = [];
    const said: unknown[] = [];
    console.warn = (...args: unknown[]) => said.push(...args);

    const logger = createLogger(recordingSink(lines));
    logger.warn("hello");

    expect(lines).toEqual(['console.warn:["hello"]']);
    expect(said).toEqual(["hello"]);
  });

  test("covers every method, including info and debug", () => {
    const lines: string[] = [];
    const infoSaid: unknown[] = [];
    const debugSaid: unknown[] = [];
    console.info = (...args: unknown[]) => infoSaid.push(...args);
    console.debug = (...args: unknown[]) => debugSaid.push(...args);

    const logger = createLogger(recordingSink(lines));
    logger.info("i");
    logger.debug("d");

    expect(lines).toEqual(['console.info:["i"]', 'console.debug:["d"]']);
    expect(infoSaid).toEqual(["i"]);
    expect(debugSaid).toEqual(["d"]);
  });

  test("stays transparent when tracing is off — it never traces and never withholds", () => {
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger({
      enabled: () => false,
      trace: () => {
        throw new Error("the logger must not trace when tracing is off");
      },
    });
    logger.warn("plain");

    expect(screen).toEqual(["plain"]);
  });

  test("flattens an Error argument with its cause chain", () => {
    const lines: string[] = [];
    const said: unknown[] = [];
    console.error = (...args: unknown[]) => said.push(...args);

    const logger = createLogger(recordingSink(lines));
    const outer = new Error("outer", { cause: new Error("inner") });
    logger.error("failed:", outer);

    expect(lines[0]).toContain('"message":"inner"');
    expect(said).toEqual(["failed:", outer]);
  });
});

describe("suspendConsolePassthrough", () => {
  test("keeps mirroring into the sink while never reaching the underlying writer", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger(recordingSink(lines));
    suspendConsolePassthrough();
    logger.warn("core/kernel/handlers/preview-export: preview.queryGeometry was failed");

    expect(lines).toEqual([
      'console.warn:["core/kernel/handlers/preview-export: preview.queryGeometry was failed"]',
    ]);
    // The regression this pins: with `consoleMode: "disabled"` the underlying writer IS the real
    // terminal, so one call through here paints raw text over the rendered frame.
    expect(screen).toEqual([]);
  });

  test("suspends every method, not just warn", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      console[method] = (...args: unknown[]) => screen.push(...args);
    }

    const logger = createLogger(recordingSink(lines));
    suspendConsolePassthrough();
    logger.log("l");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.debug("d");

    expect(lines).toHaveLength(5);
    expect(screen).toEqual([]);
  });

  test("with no trace sink, a held line reaches neither the writer nor the screen, then lands on resume", () => {
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger({ enabled: () => false, trace: () => undefined });
    suspendConsolePassthrough();
    logger.warn("nowhere else to go");

    // Nothing may reach the frame — and nothing may be lost either. With no file capturing it,
    // the line waits in memory until the renderer gives the terminal back.
    expect(screen).toEqual([]);

    resumeConsolePassthrough();
    expect(screen).toEqual(["nowhere else to go"]);
  });

  test("holds nothing when a sink is capturing — the trace file already has the line", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger(recordingSink(lines));
    suspendConsolePassthrough();
    logger.warn("traced");
    resumeConsolePassthrough();

    // Replaying a whole session's warnings onto the terminal after a normal quit would be noise,
    // not diagnostics: the file already holds them.
    expect(screen).toEqual([]);
    expect(lines).toEqual(['console.warn:["traced"]']);
  });

  test("bounds what it holds and reports how many it dropped", () => {
    const screen: unknown[] = [];
    console.warn = (...args: unknown[]) => screen.push(...args);
    console.error = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger({ enabled: () => false, trace: () => undefined });
    suspendConsolePassthrough();
    for (let index = 0; index < MAX_HELD_LINES + 3; index++) logger.warn(`line-${index}`);
    expect(screen).toEqual([]);

    resumeConsolePassthrough();

    // The oldest three fell out of the ring; the flush says so rather than hiding it, which is
    // the difference between a bounded buffer and the silent-swallow defect this branch exists
    // to undo.
    expect(screen).toHaveLength(MAX_HELD_LINES + 1);
    // The whole message, not a substring: `toContain("3")` also passes on "13", "30" or "203",
    // which is every wrong drop count this assertion exists to catch.
    expect(screen[0]).toBe(
      `termcraft: 3 earlier log line(s) were dropped while the terminal was held (the buffer keeps the most recent ${MAX_HELD_LINES})`,
    );
    expect(screen[1]).toBe("line-3");
    expect(screen.at(-1)).toBe(`line-${MAX_HELD_LINES + 2}`);
  });
});

describe("resumeConsolePassthrough", () => {
  test("hands the writer back once the renderer has released the terminal", () => {
    const lines: string[] = [];
    const screen: unknown[] = [];
    console.error = (...args: unknown[]) => screen.push(...args);

    const logger = createLogger(recordingSink(lines));
    suspendConsolePassthrough();
    logger.error("during the frame");
    resumeConsolePassthrough();
    logger.error("after teardown");

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

    const logger = createLogger(recordingSink(lines));
    resumeConsolePassthrough();
    resumeConsolePassthrough();
    logger.warn("plain");

    expect(screen).toEqual(["plain"]);
  });
});

describe("the third-party console bridge (plan P8 D4)", () => {
  test("a third-party console.warn goes through log.* once installed, and is restored on uninstall", () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      // A dependency's own call — this is exactly the shape @opentui/core's
      // `console.warn("Code highlighting failed, falling back to plain text:", error)` has.
      console.warn("Code highlighting failed", "boom");
      expect(seen).toEqual(["Code highlighting failed boom"]);

      uninstallThirdPartyConsoleBridge();
      console.warn("after");
      expect(seen).toEqual(["Code highlighting failed boom", "after"]);
    } finally {
      uninstallThirdPartyConsoleBridge();
      console.warn = original;
    }
  });

  test("installing twice is idempotent and does not chain the bridge onto itself", () => {
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      installThirdPartyConsoleBridge();
      console.error("x");
      // Exactly once — a chained bridge would double every line and, worse, could recurse.
      expect(seen).toEqual(["x"]);
    } finally {
      uninstallThirdPartyConsoleBridge();
      console.error = original;
    }
  });

  test("with NO bridge installed, log.* still reaches whatever console.warn currently is", () => {
    // The compatibility guarantee that keeps the ~30 test files which spyOn(console, …) green:
    // the indirection added for the bridge must be inert when no bridge is installed.
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      log.warn("plain");
      expect(seen).toEqual(["plain"]);
    } finally {
      console.warn = original;
    }
  });

  test("while the terminal is held, a bridged line never reaches the writer", () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      installThirdPartyConsoleBridge();
      suspendConsolePassthrough();
      console.warn("would corrupt the frame");
      expect(seen).toEqual([]);
      resumeConsolePassthrough();
      // Held, then flushed — never dropped.
      expect(seen).toEqual(["would corrupt the frame"]);
    } finally {
      resumeConsolePassthrough();
      uninstallThirdPartyConsoleBridge();
      console.warn = original;
    }
  });
});

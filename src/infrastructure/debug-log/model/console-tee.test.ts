import { afterEach, describe, expect, test } from "bun:test";

import type { TeeSink } from "../types";
import { installConsoleTee } from "./console-tee";

const ORIGINALS = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
} as const;

afterEach(() => {
  Object.assign(console, ORIGINALS);
});

function recordingSink(lines: string[]): TeeSink {
  return {
    enabled: () => true,
    trace: (channel, data) => lines.push(`${channel}:${JSON.stringify(data.args)}`),
  };
}

describe("installConsoleTee", () => {
  test("mirrors a warning into the sink and still calls the original through", () => {
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
    installConsoleTee(recordingSink(lines));
    console.info("i");
    console.debug("d");

    expect(lines).toEqual(['console.info:["i"]', 'console.debug:["d"]']);
  });

  test("does nothing at all when tracing is off", () => {
    const untouched = console.warn;
    installConsoleTee({ enabled: () => false, trace: () => undefined });

    expect(console.warn).toBe(untouched);
  });

  test("flattens an Error argument with its cause chain", () => {
    const lines: string[] = [];
    installConsoleTee(recordingSink(lines));
    console.error("failed:", new Error("outer", { cause: new Error("inner") }));

    expect(lines[0]).toContain('"message":"inner"');
  });
});

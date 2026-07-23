import { describe, expect, test } from "bun:test";

import type { UiRootAdapters } from "ui";
import { createFakeKernel } from "ui/testing";

import type { AppShell, ProcessBoundary, ShutdownSignal } from "../types";
import { AppStartupError, runApp } from "./run-app";

function recordingAdapters(calls: string[], overrides: Partial<UiRootAdapters> = {}) {
  const adapters: UiRootAdapters = {
    createRenderer: () =>
      Promise.resolve({ width: 120, height: 36, destroy: () => calls.push("destroy") }),
    createRoot: () => ({
      render: () => calls.push("render"),
      unmount: () => calls.push("unmount"),
    }),
    ...overrides,
  };
  return adapters;
}

function fakeShell(calls: string[]): AppShell {
  return {
    mode: "demo",
    port: createFakeKernel(),
    env: { root: "(demo)", workspaceIdentity: "demo" },
    close: () => {
      calls.push("shell-close");
      return Promise.resolve();
    },
  };
}

function fakeBoundary(): ProcessBoundary & {
  fire(signal: ShutdownSignal): void;
  readonly fatals: readonly { message: string; cause: unknown }[];
} {
  const handlers = new Map<ShutdownSignal, () => void>();
  const fatals: { message: string; cause: unknown }[] = [];
  return {
    onSignal: (signal, handler) => handlers.set(signal, handler),
    reportFatal: (message, cause) => fatals.push({ message, cause }),
    fire: (signal) => handlers.get(signal)?.(),
    fatals,
  };
}

describe("runApp", () => {
  test("mounts the shell and closes the UI root before the shell, exactly once", async () => {
    const calls: string[] = [];
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls),
      process: fakeBoundary(),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["render"]);

    await app.close();
    await app.close();
    await app.closed;
    expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
  });

  test("releases the shell when the UI root fails to start", async () => {
    const calls: string[] = [];
    const cause = new Error("terminal unavailable");
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls, { createRenderer: () => Promise.reject(cause) }),
      process: fakeBoundary(),
    });

    expect(app).toBeInstanceOf(AppStartupError);
    expect(calls).toEqual(["shell-close"]);
  });

  test("both shutdown signals run the one idempotent close path", async () => {
    const calls: string[] = [];
    const boundary = fakeBoundary();
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls),
      process: boundary,
    });
    if (app instanceof Error) throw app;

    boundary.fire("SIGINT");
    boundary.fire("SIGTERM");
    await app.closed;

    expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
  });

  test("a shell that fails to close is reported, not swallowed, and still resolves", async () => {
    const calls: string[] = [];
    const boundary = fakeBoundary();
    const cause = new Error("shell teardown failed");
    const app = await runApp({
      shell: { ...fakeShell(calls), close: () => Promise.reject(cause) },
      adapters: recordingAdapters(calls),
      process: boundary,
    });
    if (app instanceof Error) throw app;

    await app.close();
    await app.closed;
    expect(boundary.fatals).toHaveLength(1);
    expect(boundary.fatals[0]?.cause).toBeInstanceOf(Error);
  });
});

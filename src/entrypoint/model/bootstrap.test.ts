import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { UiRootAdapters } from "ui";

import type { ProcessBoundary } from "../types";
import { KernelCompositionPendingError, PREVIEW_SHELL_FLAG, bootstrap } from "./bootstrap";

function silentBoundary(): ProcessBoundary {
  return { onSignal: () => undefined, reportFatal: () => undefined };
}

function recordingAdapters(calls: string[]): UiRootAdapters {
  return {
    createRenderer: () => {
      calls.push("renderer");
      return Promise.resolve({ width: 120, height: 36, destroy: () => calls.push("destroy") });
    },
    createRoot: () => ({
      render: () => calls.push("render"),
      unmount: () => calls.push("unmount"),
    }),
  };
}

describe("bootstrap", () => {
  test("demo mode starts the UI against the in-memory shell", async () => {
    const calls: string[] = [];
    const app = await bootstrap("demo", {
      argv: [],
      cwd: () => "C:/projects/site",
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    await app.close();
  });

  test("interactive mode refuses to start rather than silently running the demo kernel", async () => {
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => "C:/projects/site",
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
    });

    expect(app).toBeInstanceOf(KernelCompositionPendingError);
    if (app instanceof Error === false) throw new Error("expected a startup error");
    expect(app.message).toContain(PREVIEW_SHELL_FLAG);
    expect(calls).toEqual([]);
  });

  test(`interactive mode with ${PREVIEW_SHELL_FLAG} opens the shell on the resolved project root`, async () => {
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: [PREVIEW_SHELL_FLAG, "site"],
      cwd: () => "C:/projects",
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    expect(app.shell.env.root).toBe(path.resolve("C:/projects", "site"));
    expect(app.shell.env.workspaceIdentity).toBe(path.resolve("C:/projects", "site"));
    await app.close();
  });

  test("interactive mode defaults the project root to the working directory", async () => {
    const app = await bootstrap("interactive", {
      argv: [PREVIEW_SHELL_FLAG],
      cwd: () => "C:/projects/site",
      adapters: recordingAdapters([]),
      process: silentBoundary(),
    });

    if (app instanceof Error) throw app;
    expect(app.shell.env.root).toBe(path.resolve("C:/projects/site"));
    await app.close();
  });
});

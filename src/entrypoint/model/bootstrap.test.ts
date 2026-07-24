import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { UiRootAdapters } from "ui";

import type { ProcessBoundary } from "../types";
import { bootstrap } from "./bootstrap";
import type { ShellDeps } from "./create-shell";

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

const NEVER_SPAWN: ShellDeps["spawn"] = () => {
  throw new Error("spawn must not be called while merely composing a shell");
};

const scratchDirs: string[] = [];
function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function shellDepsFor(scratch: string): ShellDeps {
  return {
    userStateRoot: path.join(scratch, "user-state"),
    execPath: "bun",
    isCompiled: false,
    srcRoot: "src/main.tsx",
    spawn: NEVER_SPAWN,
  };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

  test("interactive mode composes the real Kernel and starts the UI against it", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-");
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => scratch,
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    expect(fs.existsSync(path.join(scratch, ".termcraft"))).toBe(true);
    await app.close();
  });

  test("interactive mode with a target argument opens the shell on the resolved project root", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-target-");
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: ["site"],
      cwd: () => scratch,
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    expect(app.shell.env.root).toBe(path.resolve(scratch, "site"));
    await app.close();
  });

  test("interactive mode defaults the project root to the working directory", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-default-");
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => scratch,
      adapters: recordingAdapters([]),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    if (app instanceof Error) throw app;
    expect(app.shell.env.root).toBe(path.resolve(scratch));
    await app.close();
  });
});

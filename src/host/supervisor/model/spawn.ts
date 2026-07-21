import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnCommand, SpawnFn, SpawnedChild } from "../types";
import { SupervisorError } from "./errors";

/**
 * The §13 environment allowlist: explicit locale + timezone, no inherited API
 * keys/tokens/agent values. On Windows, Bun still injects a system-var baseline
 * (PATH/SYSTEMROOT/…, Spike 04 D3) that this cannot suppress; that baseline
 * carries no secrets.
 */
export function buildChildEnv(): Record<string, string> {
  return { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" };
}

function defaultScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-host-"));
}

/**
 * The production `Bun.spawn` adapter. Spawns the argument array with only
 * stdin/stdout/stderr pipes, the allowlist env, and a fresh scratch cwd. The
 * spawn call is wrapped in a raw try/catch IIFE mapping ANY throw to a typed
 * `SupervisorError("SPAWN_FAILED")` with the OS code (D1 — the throw is Error
 * here, but never depend on that).
 */
export function createBunSpawn(options?: { makeScratchDir?: () => string }): SpawnFn {
  const makeScratchDir = options?.makeScratchDir ?? defaultScratchDir;
  return (command: SpawnCommand) => {
    const scratch = (() => {
      try {
        return makeScratchDir();
      } catch (cause) {
        return new SupervisorError({
          code: "SPAWN_FAILED",
          reason: `scratch dir creation failed: ${describe(cause)}`,
          cause: asError(cause),
        });
      }
    })();
    if (scratch instanceof SupervisorError) return scratch;

    return (() => {
      try {
        const proc = Bun.spawn({
          cmd: [...command.cmd],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: scratch,
          env: buildChildEnv(),
        });
        return proc as unknown as SpawnedChild;
      } catch (cause) {
        return new SupervisorError({
          code: "SPAWN_FAILED",
          reason: describe(cause),
          cause: asError(cause),
        });
      }
    })();
  };
}

function describe(cause: unknown): string {
  const code = (cause as { code?: unknown })?.code;
  const message = (cause as { message?: unknown })?.message ?? cause;
  return code === undefined ? String(message) : `${String(code)}: ${String(message)}`;
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined;
}

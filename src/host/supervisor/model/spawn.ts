import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { trace } from "infrastructure/debug-log";

import type { SpawnCommand, SpawnFn, SpawnedChild } from "../types";
import { SupervisorError, osFailureReason } from "./errors";

/**
 * The §13 environment allowlist: explicit locale + timezone, no inherited API
 * keys/tokens/agent values. On Windows, Bun still injects a system-var baseline
 * (PATH/SYSTEMROOT/…, Spike 04 D3) that this cannot suppress; that baseline
 * carries no secrets.
 *
 * `TERMCRAFT_DEBUG_LOG` is forwarded when the parent has tracing on, and is the one
 * deliberate widening of the list. It carries a file path this process minted, never a
 * credential, so it does not weaken what §13 is actually protecting — and without it the
 * design host is undiagnosable. The child is a re-invocation of this same binary, so it
 * resolves the variable through the same sink: unset, it defaulted to a run file under its
 * own cwd, which `createBunSpawn` sets to a throwaway scratch directory. Every smoke render,
 * export render and preview session therefore wrote its diagnostics to a temp path nobody
 * would ever read, and the process that mounts and renders a page — the one that answers
 * "why did this page fail" — was the single least observable part of the system.
 */
export function buildChildEnv(
  env: Readonly<Partial<Record<string, string>>> = process.env,
): Record<string, string> {
  const debugLog = env["TERMCRAFT_DEBUG_LOG"];
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    ...(debugLog === undefined || debugLog.length === 0 ? {} : { TERMCRAFT_DEBUG_LOG: debugLog }),
  };
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
 *
 * Both reasons go through `osFailureReason` rather than the throw's own message: the scratch
 * directory IS an absolute temp path, so libuv's message for a failed `mkdtemp` names it, and
 * a `SupervisorError.reason` is a §13 diagnostic that promises none. The full throw survives
 * on `cause`.
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
          reason: `scratch dir creation failed: ${osFailureReason(cause)}`,
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
        // DIAGNOSTIC: the parent-side instant of the spawn. The child writes `main.start` into
        // this SAME run file (`buildChildEnv` forwards TERMCRAFT_DEBUG_LOG), so the gap between
        // these two lines is the child's startup cost — the number HANDOFF Finding 4 had to
        // reconstruct from scratch-directory mtimes because neither end was logged.
        trace("host.spawn", { scratch, cmd: command.cmd });
        return proc as unknown as SpawnedChild;
      } catch (cause) {
        return new SupervisorError({
          code: "SPAWN_FAILED",
          reason: osFailureReason(cause),
          cause: asError(cause),
        });
      }
    })();
  };
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined;
}

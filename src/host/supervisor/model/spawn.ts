import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { log, trace } from "infrastructure/debug-log";

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

const SCRATCH_PREFIX = "termcraft-host-";
/** `fs.mkdtempSync` appends exactly six random characters to the prefix. */
const SCRATCH_DIR_PATTERN = /^termcraft-host-[A-Za-z0-9]{6}$/;
/** Old enough that no live incarnation could still be using it — see {@link sweepStaleScratchDirs}. */
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * How many directories one sweep may delete. {@link sweepStaleScratchDirs} runs on the BOOT path
 * (`entrypoint/model/create-shell.ts`) and is synchronous, so its whole cost is dead time before
 * the first frame — housekeeping "must not stop the app from starting" (Task 7's own principle),
 * and an unbounded loop over an inherited backlog is exactly that.
 *
 * MEASURED, not assumed (maintainer's Windows 11 machine, 2026-07-28, `fs.rmSync` recursive —
 * the same call {@link removeScratchDir} makes): 330 deletions across two populations — 30 real
 * abandoned scratch directories cold on disk, and one 300-directory synthetic batch — gave a
 * median of 0.26 ms, a p95 of 1.4 ms and a single worst sample of 10.8 ms per directory;
 * enumerating 179 entries (one `readdirSync` plus a `statSync` each) cost 11 ms. The review that
 * asked for this cap projected ~190 ms per directory (~53 s for a 277-directory backlog); that
 * figure did not reproduce here and is not recorded as fact — it came from a one-time hand sweep
 * that was never timed.
 *
 * 64 is chosen against the WORST single sample rather than the median: 64 x 10.8 ms = 0.7 s, so
 * the sweep stays clearly sub-second even if every directory in a run is as slow as the slowest
 * one ever observed, while the ordinary case is ~17 ms. It also drains a 277-directory backlog
 * in five launches, so a cap is a delay and never a leak.
 */
export const SCRATCH_SWEEP_MAX_DELETIONS = 64;

/** What one capped sweep will delete, and how much of the backlog it is leaving for the next run. */
export interface StaleScratchSelection {
  /** Oldest first, at most `maxDeletions` long. */
  readonly selected: readonly string[];
  /** Stale directories the cap left in place. `0` means the backlog was fully drained. */
  readonly skipped: number;
}

/**
 * Which temp entries are abandoned scratch directories of ours, capped at `maxDeletions`.
 *
 * Pure and name-based, in the same spirit as `debug-log`'s own `selectRunsToPrune`: an entry this
 * module does not recognise as its own is never a candidate, so an operator's directory in
 * `%TEMP%` is not ours to delete. The age bound is what makes this safe against a CONCURRENT
 * termcraft: a sibling's live scratch dir is minutes old, never a day.
 *
 * OLDEST FIRST, and `skipped` is returned rather than inferred. `readdirSync` promises no order,
 * so without the sort "the first 64" would be an arbitrary 64 and a backlog could drain in an
 * order nobody can predict; and a truncated sweep that reported nothing would read to the next
 * reader exactly like a complete one — the silent-truncation defect this branch exists to remove.
 */
export function selectStaleScratchDirs(
  entries: readonly { readonly name: string; readonly mtimeMs: number }[],
  nowMs: number,
  maxAgeMs: number,
  maxDeletions: number,
): StaleScratchSelection {
  const stale = entries
    .filter((entry) => SCRATCH_DIR_PATTERN.test(entry.name) && nowMs - entry.mtimeMs > maxAgeMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.name);
  const selected = stale.slice(0, Math.max(0, maxDeletions));
  return { selected, skipped: stale.length - selected.length };
}

/** Remove one scratch directory; a failure is never worth propagating (see {@link sweepStaleScratchDirs}). */
function removeScratchDir(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (cause) {
    // On Windows a directory that is still a live process's cwd refuses deletion. Leaving it is
    // the correct outcome — the next sweep collects it — and a cleanup that could throw into the
    // spawn path would be strictly worse than a stray directory.
    log.warn(`host: could not remove scratch directory ${directory}`, cause);
  }
}

/**
 * Delete abandoned `termcraft-host-*` directories left by earlier runs (HANDOFF Finding 5 flagged
 * the accumulation; the one-time sweep run for this fix found 922 in `%TEMP%`, 336 of them not
 * even empty). Call ONCE per process, from the composition root — never per spawn.
 *
 * A run that dies without reaping — a crash, a kill, a power loss — cannot delete its own
 * directory on exit, so the per-child cleanup below can never be complete on its own.
 *
 * Bounded per run by {@link SCRATCH_SWEEP_MAX_DELETIONS}, because this runs before anything is
 * drawn; a truncated sweep SAYS so, through this module's own `console.warn` housekeeping channel
 * (errore rule 21 — the outcome is not propagated, so it must leave a trace), rather than reading
 * like a complete one.
 */
export function sweepStaleScratchDirs(nowMs: number = Date.now()): void {
  const tmp = os.tmpdir();
  try {
    const entries = fs
      .readdirSync(tmp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
      .map((entry) => ({
        name: entry.name,
        mtimeMs: fs.statSync(path.join(tmp, entry.name)).mtimeMs,
      }));
    const stale = selectStaleScratchDirs(
      entries,
      nowMs,
      SCRATCH_MAX_AGE_MS,
      SCRATCH_SWEEP_MAX_DELETIONS,
    );
    for (const name of stale.selected) {
      removeScratchDir(path.join(tmp, name));
    }
    trace("host.scratchSweep", {
      scanned: entries.length,
      deleted: stale.selected.length,
      skipped: stale.skipped,
      cap: SCRATCH_SWEEP_MAX_DELETIONS,
    });
    if (stale.skipped > 0) {
      log.warn(
        `host: scratch-directory sweep stopped at its per-run cap of ${SCRATCH_SWEEP_MAX_DELETIONS} — ` +
          `${stale.skipped} abandoned directories remain in ${tmp} and the next launch continues the sweep`,
      );
    }
  } catch (cause) {
    // Best-effort housekeeping: an unreadable %TEMP% must not stop the app from starting.
    log.warn(`host: scratch-directory sweep could not read the temp directory (${tmp})`, cause);
  }
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
        // The scratch dir is this child's cwd, so it can only go once the child is gone.
        // `exited` resolves on every ending — clean exit, SIGTERM from the supervisor's own
        // forced stop, or a crash. Both arms of `.then` are handled, not just the fulfilled one:
        // an unhandled rejection here would reach `process-boundary.ts`'s own
        // `unhandledRejection` listener and take down the whole live session over housekeeping.
        void proc.exited.then(
          () => removeScratchDir(scratch),
          (cause) =>
            log.warn(`host: scratch cleanup skipped for ${scratch} — exited rejected`, cause),
        );
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

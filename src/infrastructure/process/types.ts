import * as errore from "errore"

/** A Job Object / process-group primitive failure (Spike I). Domain-free. */
export class ProcessTreeError extends errore.createTaggedError({
  name: "ProcessTreeError",
  message: "Process-tree failure: $reason",
}) {}

/**
 * One owned process tree (Windows Job Object with kill-on-close, Spike I). Knows
 * nothing about Turns or Pages — it owns a set of OS processes. `adopt` assigns a
 * spawned pid; `activeProcesses` is a genuine OS read of the live descendant count
 * (`QueryInformationJobObject` / `JobObjectBasicAccountingInformation`), NOT a PID
 * poll; `terminate` hard-kills the whole tree; `close` releases the handle
 * (kill-on-close then fires for any survivor).
 *
 * `close` is idempotent AND invalidating: after the first call, `adopt` /
 * `activeProcesses` / `terminate` refuse with a `ProcessTreeError` instead of
 * touching the released handle — Windows recycles HANDLE values aggressively,
 * so operating on a stale value after release risks naming a since-reused,
 * unrelated kernel object.
 */
export interface ProcessTree {
  /** Assign a spawned process (and its future descendants) into the job. */
  adopt(pid: number): ProcessTreeError | null
  /** Live owned-descendant count from the OS, or a tagged error if the handle is gone. */
  activeProcesses(): ProcessTreeError | number
  /** Hard-kill the whole tree (`TerminateJobObject`). */
  terminate(): ProcessTreeError | null
  /** Release the job handle. Safe to call more than once. */
  close(): void
  /**
   * Record whether a spawn's adoption into this tree was confirmed
   * successful — `adopt()` returned `null` AND a subsequent
   * `activeProcesses()` re-read reported at least one owned process.
   * `makeSpawnClaudeCodeProcess` (agent/model/query-fn.ts) calls this with
   * `false` on every degraded branch (missing pid, `adopt()` failure,
   * verify-read failure, verify count `< 1`) and with `true` once the
   * membership re-read confirms it, instead of only `console.warn`-ing.
   * Sticky in one direction: once `true` has been recorded, a later `false`
   * never un-confirms the tree (only one CLI is spawned per tree today, but
   * a stale failure on a re-adopt attempt must not erase an earlier
   * confirmed success).
   */
  noteAdoptionOutcome(confirmed: boolean): void
  /**
   * Whether `noteAdoptionOutcome(true)` has ever been recorded for this
   * tree. Callers polling `activeProcesses()` toward a confirmed exit MUST
   * require this to be `true` before treating a `0` read as a confirmed
   * exit — otherwise `0` is ambiguous between "the tree drained" and
   * "nothing was ever successfully adopted into it".
   */
  ownershipConfirmed(): boolean
}

/** Constructs a fresh owned tree, or a typed failure on an unsupported platform. */
export type ProcessTreeFactory = () => ProcessTreeError | ProcessTree

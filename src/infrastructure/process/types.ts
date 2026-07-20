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
 */
export interface ProcessTree {
  /** Assign a spawned process (and its future descendants) into the job. */
  adopt(pid: number): ProcessTreeError | null
  /** Live owned-descendant count from the OS, or a tagged error if the handle is gone. */
  activeProcesses(): ProcessTreeError | number
  /** Hard-kill the whole tree (`TerminateJobObject`). */
  terminate(): ProcessTreeError | null
  /** Release the job handle. */
  close(): void
}

/** Constructs a fresh owned tree, or a typed failure on an unsupported platform. */
export type ProcessTreeFactory = () => ProcessTreeError | ProcessTree

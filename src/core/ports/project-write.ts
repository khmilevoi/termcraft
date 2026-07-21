/**
 * `ProjectWriteCoordinator` — blocker B2's core-side shape. B2: "`store/transaction`'s
 * `WriteMutex` exists but `store/types.ts` divergence note 1 deliberately hides it, and
 * `OpenProject` exposes no `writeMutex`. Export's mandated short `ProjectWritePermit`
 * (kernel-command-contract §7.5, §12.5) cannot be taken. Resolution: expose the SAME
 * instance the engine already uses. Creating a second mutex silently breaks single-writer
 * exclusion and is forbidden."
 *
 * This is exactly that exposure: a narrow port over `store/transaction`'s real `WriteMutex`
 * (acquire/release/isActive only — `chain` stays store-internal plumbing no `core` caller
 * needs, since every ordinary write already goes through `turn-transactions.ts` or a
 * dedicated mutation port that manages its own chain). `ProjectWritePermit` is declared
 * HERE, not re-declared per consuming port, so every port in this ring that needs to name a
 * permit (this file's own callers, and any future short-permit caller such as Export's
 * snapshot) imports the same local type rather than a second, drifting copy.
 */

/** An opaque, randomly-minted permit (turn-durability §4.5). `release` invalidates it for every later `isActive` check — a stale async continuation cannot write after release. */
export interface ProjectWritePermit {
  readonly permitId: string
}

/**
 * The one project-write mutex a project has (turn-durability §4.5): FIFO-fair acquisition,
 * idempotent release, and a liveness check every mutating step must pass before it writes.
 * `store`'s real `TransactionEngine` (see `turn-transactions.ts`) already holds and drives
 * this same instance for every turn admission/finalize/terminalize call — this port exists
 * so a caller OUTSIDE that engine (Export's short-permit snapshot, a future standalone
 * project-mutation) can take a permit against the identical mutex rather than a second one.
 */
export interface ProjectWriteCoordinator {
  /** Resolves in exact call order (FIFO). */
  acquire(): Promise<ProjectWritePermit>
  /** Idempotent: releasing an already-stale permit is a no-op and never drops a later holder's lock. */
  release(permit: ProjectWritePermit): void
  /** `false` once `release` has run for this permit, or a later `acquire` has since won the mutex. */
  isActive(permit: ProjectWritePermit): boolean
}

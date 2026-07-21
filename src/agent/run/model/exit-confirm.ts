import * as errore from "errore"
import type { ProcessTree } from "infrastructure/process"
import { ProcessTreeError } from "infrastructure/process"

/**
 * Nominal spacing between `activeProcesses()` polls. This bounds the ATTEMPT
 * COUNT for a given budget, not real elapsed time: `wait` is an injected seam
 * and production is the only caller that actually sleeps here, so timing the
 * budget against a real clock would make deterministic tests either spin
 * needlessly (a no-op `wait` never advances real time) or need to fake global
 * timers. `Math.ceil(budgetMs / POLL_INTERVAL_MS)` attempts is the compromise.
 * Exported so tests can assert `wait` is spaced correctly without
 * duplicating the literal.
 */
export const POLL_INTERVAL_MS = 100

/** Renders a thrown value into a stable message even when it is not an `Error` instance. */
function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Boundary guard: `processTree` is an injected seam (the real FFI adapter,
 * or a test double) that is typed to never throw from `activeProcesses()` —
 * but an injected implementation misbehaving must not be able to crash the
 * poll loop. Sync boundary, so `errore.try` (not `.catch()`) per errore
 * rule 12.
 */
function safeActiveProcesses(processTree: ProcessTree): ProcessTreeError | number {
  return errore.try({
    try: () => processTree.activeProcesses(),
    catch: (cause) => new ProcessTreeError({ reason: `activeProcesses() threw: ${describeThrown(cause)}`, cause }),
  })
}

/** Same boundary guard as {@link safeActiveProcesses}, for `terminate()`. */
function safeTerminate(processTree: ProcessTree): ProcessTreeError | null {
  return errore.try({
    try: () => processTree.terminate(),
    catch: (cause) => new ProcessTreeError({ reason: `terminate() threw: ${describeThrown(cause)}`, cause }),
  })
}

/**
 * Boundary guard: `wait` is an injected seam (production sleeps, tests
 * script it) whose documented shape is "never rejects". A misbehaving
 * injection must not be able to propagate a rejection up through
 * `confirmExit` — that rejection would otherwise escape into whichever
 * caller is awaiting it (the natural-completion path's already-latched
 * success, or `runCancelLadder`'s memoized `cancelPromise`) and leave
 * `outcome` pending forever / make `cancel()` throw. A rejection here is
 * logged and treated as "this attempt's wait is unusable", not propagated —
 * the poll loop simply moves to its next attempt instead of hanging.
 */
async function safeWait(wait: (ms: number) => Promise<void>, ms: number): Promise<void> {
  await wait(ms).catch((cause) => {
    console.warn("agent/run: injected wait() rejected during exit confirmation:", describeThrown(cause))
  })
}

/**
 * Poll `processTree.activeProcesses()` until it reports zero or `budgetMs` of
 * (nominal) attempts is exhausted. A `ProcessTreeError` is logged and treated
 * as "not confirmed yet" for that attempt — transient FFI failures still get
 * to clear within the remaining budget; a failure that never clears degrades
 * to `false` (never thrown) so a caller can fall back to `unconfirmed-exit`.
 *
 * A `0` read only counts as a confirmed exit once `processTree.ownershipConfirmed()`
 * is also `true` — otherwise `0` is ambiguous between "the tree drained" and
 * "nothing was ever successfully adopted into it", and the latter must not
 * read as a confirmed exit.
 */
export async function confirmExit(
  processTree: ProcessTree,
  wait: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / POLL_INTERVAL_MS))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const count = safeActiveProcesses(processTree)
    if (count instanceof ProcessTreeError) {
      console.warn("agent/run: activeProcesses() failed while confirming exit:", count.message)
    } else if (count === 0) {
      if (processTree.ownershipConfirmed()) return true
      console.warn(
        "agent/run: activeProcesses() reported zero but ownership of this tree was never confirmed; not treating it as a confirmed exit",
      )
    }
    if (attempt < maxAttempts - 1) await safeWait(wait, POLL_INTERVAL_MS)
  }
  return false
}

/**
 * §6.5 escalation: send tree-wide termination, then re-poll within a fresh
 * budget. Both the cancel ladder's rung 4 and the natural-completion
 * escalation are this exact sequence — it lives here once so the two can
 * never drift apart.
 */
export async function escalateAndConfirm(
  processTree: ProcessTree,
  wait: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const terminateResult = safeTerminate(processTree)
  if (terminateResult instanceof ProcessTreeError) {
    console.warn("agent/run: processTree.terminate() failed while escalating:", terminateResult.message)
  }
  return confirmExit(processTree, wait, budgetMs)
}

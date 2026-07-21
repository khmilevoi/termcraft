import * as errore from "errore"
import type { AgentRun, AgentRunOutcome } from "agent/types"
import type { TurnFence } from "entities/turn"
import type { NaturalOutcome, RunDeps, RunDriver, RunSink } from "../types"
import { createEventQueue } from "./event-queue"
import { confirmExit, escalateAndConfirm } from "./exit-confirm"

/**
 * Cancellation reason handed to `abortController.abort()` (§6.5 rung 1).
 * Extends `errore.AbortError` so `errore.isAbortError` detects it even after it
 * is wrapped in a `.catch()` cause chain elsewhere.
 */
class TurnAbortError extends errore.createTaggedError({
  name: "TurnAbortError",
  message: "turn cancelled",
  extends: errore.AbortError,
}) {}

/** A driver that threw past its own boundary. The engine's backstop — a driver
 *  is expected to convert its own boundary throws into `complete()`. */
class RunDriverError extends errore.createTaggedError({
  name: "RunDriverError",
  message: "agent run failed: $reason",
}) {}

/** Default §6.5 exit-confirmation budget when the caller does not override it. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Drive one fenced attempt. The driver streams through an internal queue
 * decoupled from it, and runs fire-and-forget: `outcome` settles whether or not
 * anything ever reads `run.events`.
 *
 * A single `terminalKind` latch decides who resolves `outcome`: whichever of
 * the driver's natural completion or `cancel()` flips it first wins, and the
 * loser's remaining work is discarded. `cancel()` is memoized so concurrent
 * calls share one ladder run.
 *
 * Non-Reatom: the latch, the queue and the cancel memo are explicit
 * closure-owned state scoped to one run's lifetime, matching `agent/`'s
 * non-Reatom adapter status (CLAUDE.md).
 */
export function startAgentRun(
  fence: TurnFence,
  driver: RunDriver,
  deps: RunDeps,
): { run: AgentRun; cancel: () => Promise<void> } {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const queue = createEventQueue(fence)

  let terminalKind: "natural" | "cancelled" | null = null
  /** Compare-and-swap the termination latch; returns true only for the winner. */
  function latch(kind: "natural" | "cancelled"): boolean {
    if (terminalKind !== null) return false
    terminalKind = kind
    return true
  }

  let resolveOutcome: (outcome: AgentRunOutcome) => void = () => {}
  const outcomePromise = new Promise<AgentRunOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  /**
   * turn-durability §6.4/§6.5: a natural completion must CONFIRM the whole
   * process tree exited before the kernel may retire the fence and snapshot the
   * candidate workspace. If the first poll cannot confirm, escalate exactly like
   * the cancel ladder before falling back to `unconfirmed-exit`.
   */
  async function resolveWithExitConfirm(outcome: AgentRunOutcome): Promise<void> {
    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      resolveOutcome(outcome)
      return
    }
    console.warn(
      `agent/run: exit not confirmed after natural ${outcome.kind}, escalating to terminate() before reporting an outcome`,
    )
    const reconfirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(reconfirmed ? outcome : { kind: "unconfirmed-exit" })
  }

  let claimed: NaturalOutcome | null = null

  const sink: RunSink = {
    isTerminal: () => terminalKind !== null,
    emit: (event) => {
      if (terminalKind !== null) return // late-event drop (§6.4)
      queue.push(event)
    },
    complete: (outcome, finalEvents) => {
      if (!latch("natural")) return // cancel already won (late-event drop, §6.4)
      for (const event of finalEvents ?? []) queue.push(event)
      queue.finish()
      claimed = outcome
    },
  }

  async function runDriver(): Promise<void> {
    try {
      await driver(sink)
    } catch (cause) {
      // Backstop only: a driver is expected to convert its own boundary throws.
      // Swallowed and logged (errore rule 21) so a leak cannot leave `outcome`
      // pending forever.
      console.warn("agent/run: driver threw past its own boundary:", describeThrown(cause))
      if (latch("natural")) {
        const driverError = new RunDriverError({ reason: describeThrown(cause), cause })
        queue.push({ kind: "error", message: driverError.message })
        queue.finish()
        claimed = { kind: "backend-error", message: driverError.message, sessionId: null }
      }
    }

    if (claimed === null && latch("natural")) {
      // The driver returned without claiming an outcome and without cancel
      // winning — report it as a failure so `outcome` still settles.
      const message = "agent run ended without a terminal outcome"
      queue.push({ kind: "error", message })
      queue.finish()
      claimed = { kind: "backend-error", message, sessionId: null }
    }

    if (claimed !== null) await resolveWithExitConfirm(claimed)
  }

  // Fire-and-forget: `outcome` must settle even if `events` is never read.
  void runDriver()

  let cancelPromise: Promise<void> | null = null

  /**
   * turn-durability §6.5's cancel ladder is five rungs: (1) stop non-terminal
   * events + graceful backend cancel, (2) wait <=5s, (3) send graceful TREE
   * termination and wait <=5s, (4) hard-kill and wait <=5s, (5) only then may
   * the caller snapshot/quarantine/reuse.
   *
   * This implements rungs 1, 2 and 4 and stops there; rung 5's disposition is
   * the caller's decision, made from this function's outcome. The budget is
   * therefore 10s (2 rungs of <=5s), not the spec's 15s.
   *
   * NOTE FOR TASK 7: the full rung-3 divergence analysis currently lives on
   * `runCancelLadder` in `agent/claude/model/agent-run.ts`. Move it here
   * verbatim — CLAUDE.md requires a documented divergence to stay in a code
   * comment, and this is now its only home.
   */
  async function runCancelLadder(): Promise<void> {
    deps.abortController.abort(new TurnAbortError({})) // rung 1

    if (!latch("cancelled")) {
      // A natural outcome already won, or a previous cancel() already ran —
      // never fight the winner, just wait for whatever it resolved.
      await outcomePromise
      return
    }
    queue.finish() // cancellation carries no AgentEvent — just end the stream.

    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      // rung 2
      resolveOutcome({ kind: "cancelled", exitConfirmed: true })
      return
    }

    // rung 4 (hard kill) — rung 3 is the documented gap above.
    const confirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(confirmed ? { kind: "cancelled", exitConfirmed: true } : { kind: "unconfirmed-exit" })
  }

  function cancel(): Promise<void> {
    if (cancelPromise === null) cancelPromise = runCancelLadder()
    return cancelPromise
  }

  const run: AgentRun = { fence, events: queue.iterable, outcome: outcomePromise }
  return { run, cancel }
}

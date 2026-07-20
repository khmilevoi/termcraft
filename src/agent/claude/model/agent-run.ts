import * as errore from "errore"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent } from "entities/turn"
import type { ProcessTree } from "infrastructure/process"
import { ProcessTreeError } from "infrastructure/process"
import type { AgentRun, AgentRunOutcome, AgentTask, FencedEvent } from "agent/types"
import type { ClaudeQueryFn } from "../types"
import { ClaudeSdkError } from "./errors"
import { deriveUsage, normalizeMessage } from "./normalize"

/**
 * Cancellation reason handed to `abortController.abort()` (§6.5 step 1).
 * Extends `errore.AbortError` so `errore.isAbortError` detects it even after
 * it is wrapped in a `.catch()` cause chain elsewhere.
 */
class TurnAbortError extends errore.createTaggedError({
  name: "TurnAbortError",
  message: "turn cancelled",
  extends: errore.AbortError,
}) {}

/** Default §6.5 exit-confirmation budget when the caller does not override it. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000

/**
 * Nominal spacing between `activeProcesses()` polls. This bounds the ATTEMPT
 * COUNT for a given budget, not real elapsed time: `wait` is an injected seam
 * and production is the only caller that actually sleeps here, so timing the
 * budget against a real clock would make deterministic tests either spin
 * needlessly (a no-op `wait` never advances real time) or need to fake global
 * timers. `Math.ceil(budgetMs / POLL_INTERVAL_MS)` attempts is the compromise.
 * Exported so tests can assert `wait` is spaced correctly (finding [8])
 * without duplicating the literal.
 */
export const POLL_INTERVAL_MS = 100

export interface RunDeps {
  readonly queryFn: ClaudeQueryFn
  readonly processTree: ProcessTree
  readonly abortController: AbortController
  /** Injectable delay for the §6.5 waits; production = `(ms) => Bun.sleep(ms)`. */
  readonly wait: (ms: number) => Promise<void>
  readonly confirmTimeoutMs?: number
  /** Built by `buildQueryOptions(task, …)` in `claude-backend` (T14). */
  readonly options: Options
  /** Built by `buildPrompt(task)` in `claude-backend` (T14). */
  readonly prompt: string
}

/** Renders a thrown SDK-stream value into a stable message even when it is not an `Error` instance. */
function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}

/**
 * Boundary guard (finding [25]): `processTree` is an injected seam (the real
 * FFI adapter, or a test double) that is typed to never throw from
 * `activeProcesses()` — but an injected implementation misbehaving must not
 * be able to crash the poll loop. Sync boundary, so `errore.try` (not
 * `.catch()`) per errore rule 12.
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
 * Boundary guard (finding [25]): `wait` is an injected seam (production
 * sleeps, tests script it) whose documented shape is "never rejects". A
 * misbehaving injection must not be able to propagate a rejection up through
 * `pollUntilZero` — that rejection would otherwise escape into whichever
 * caller is awaiting it (`resolveAfterExitConfirm`'s already-latched success
 * path, or `runCancelLadder`'s memoized `cancelPromise`) and leave `outcome`
 * pending forever / make `cancel()` throw. A rejection here is logged and
 * treated as "this attempt's wait is unusable", not propagated — the poll
 * loop simply moves to its next attempt instead of hanging.
 */
async function safeWait(wait: (ms: number) => Promise<void>, ms: number): Promise<void> {
  await wait(ms).catch((cause) => {
    console.warn("agent/agent-run: injected wait() rejected during exit confirmation:", describeThrown(cause))
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
 * is also `true` (finding [22]'s downstream half) — otherwise `0` is
 * ambiguous between "the tree drained" and "nothing was ever successfully
 * adopted into it", and the latter must not read as a confirmed exit.
 */
async function pollUntilZero(
  processTree: ProcessTree,
  wait: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / POLL_INTERVAL_MS))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const count = safeActiveProcesses(processTree)
    if (count instanceof ProcessTreeError) {
      console.warn("agent/agent-run: activeProcesses() failed while confirming exit:", count.message)
    } else if (count === 0) {
      if (processTree.ownershipConfirmed()) return true
      console.warn(
        "agent/agent-run: activeProcesses() reported zero but ownership of this tree was never confirmed; not treating it as a confirmed exit",
      )
    }
    if (attempt < maxAttempts - 1) await safeWait(wait, POLL_INTERVAL_MS)
  }
  return false
}

/** A minimal single-reader async queue bridging the SDK generator to `AgentRun.events`. */
interface EventQueue {
  push(event: AgentEvent): void
  finish(): void
  readonly iterable: AsyncIterable<FencedEvent>
}

/**
 * Push/finish never depend on a reader — `driveQuery` below calls them
 * unconditionally, so `outcome` settles even when nobody ever iterates
 * `events` (turn-durability §6.4).
 *
 * Two invariants close finding [27]:
 *  - `[Symbol.asyncIterator]()` hands out the ONE real reader (matching this
 *    function's "single-reader" contract above); a second, concurrent call
 *    would otherwise share the same `waitingReader` slot, clobber the first
 *    reader's pending `next()`, and deadlock it forever with no signal. A
 *    second iterator instead fails loudly on its first `next()`.
 *  - The real reader's iterator implements `return()`, so a consumer that
 *    `break`s out of `for await (const e of run.events)` (the JS spec calls
 *    `return()` on abrupt loop completion) tells the producer nobody is
 *    listening anymore. From then on `push` drops events instead of
 *    retaining them in `buffered` for the rest of the turn — durability only
 *    requires that `push` never BLOCK (see the comment above), not that it
 *    retain output forever once the one reader is provably gone.
 */
function createEventQueue(fence: AgentTask["fence"]): EventQueue {
  const buffered: FencedEvent[] = []
  let waitingReader: ((result: IteratorResult<FencedEvent>) => void) | null = null
  let done = false
  let abandoned = false
  let abandonedDropLogged = false
  let readerTaken = false

  function push(event: AgentEvent): void {
    if (abandoned) {
      if (!abandonedDropLogged) {
        abandonedDropLogged = true
        console.warn("agent/agent-run: events consumer is gone (break/return); dropping further events")
      }
      return
    }
    const item: FencedEvent = { fence, event }
    if (waitingReader !== null) {
      const resolve = waitingReader
      waitingReader = null
      resolve({ value: item, done: false })
      return
    }
    buffered.push(item)
  }

  function finish(): void {
    done = true
    if (waitingReader !== null) {
      const resolve = waitingReader
      waitingReader = null
      resolve({ value: undefined, done: true })
    }
  }

  function next(): Promise<IteratorResult<FencedEvent>> {
    const buffered0 = buffered.shift()
    if (buffered0 !== undefined) return Promise.resolve({ value: buffered0, done: false })
    if (done) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      waitingReader = resolve
    })
  }

  function returnReader(): Promise<IteratorResult<FencedEvent>> {
    abandoned = true
    buffered.length = 0 // nothing will ever read this again — release it now
    waitingReader = null
    return Promise.resolve({ value: undefined, done: true })
  }

  return {
    push,
    finish,
    iterable: {
      [Symbol.asyncIterator]() {
        if (readerTaken) {
          // A second concurrent reader (finding [27]) — fail loudly instead
          // of sharing `waitingReader` with the first and deadlocking it.
          return {
            next: () =>
              Promise.reject(new Error("agent/agent-run: AgentRun.events supports only one reader at a time")),
          }
        }
        readerTaken = true
        return { next, return: returnReader }
      },
    },
  }
}

/**
 * Drive one fenced attempt. Streams `FencedEvent`s (stamped with `task.fence`)
 * through an internal queue decoupled from the SDK generator — `driveQuery`
 * below starts immediately (fire-and-forget) and runs to completion whether
 * or not anything ever reads `run.events`.
 *
 * A single `terminalKind` latch decides who gets to resolve `outcome`:
 * whichever of "the SDK stream reaching a result/throwing" or "cancel()"
 * flips it first wins; the loser's remaining work is discarded (late-event
 * drop, §6.4). `cancel()` is memoized so concurrent calls share one ladder
 * run.
 *
 * Non-Reatom: `terminalKind`, the queue, and the cancel memo below are
 * explicit closure-owned state scoped to one run's lifetime, not a Reatom
 * atom — matches `agent/`'s non-Reatom adapter status (CLAUDE.md).
 */
export function startClaudeRun(task: AgentTask, deps: RunDeps): { run: AgentRun; cancel: () => Promise<void> } {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const queue = createEventQueue(task.fence)

  let terminalKind: "natural" | "cancelled" | null = null
  /** Compare-and-swap the termination latch; returns true only for the winner. */
  function latch(kind: "natural" | "cancelled"): boolean {
    if (terminalKind !== null) return false
    terminalKind = kind
    return true
  }

  let lastSessionId: string | null = null
  let resolveOutcome: (outcome: AgentRunOutcome) => void = () => {}
  const outcomePromise = new Promise<AgentRunOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  /**
   * turn-durability §6.4/§6.5: completion must CONFIRM the whole process tree
   * exited before the kernel is allowed to retire the fence and snapshot the
   * candidate workspace — an unconfirmed natural completion is NOT
   * indistinguishable from a clean one (finding [24]/[29]). If the first poll
   * cannot confirm, escalate exactly like the cancel ladder's rungs 3-4
   * (terminate, then re-poll) before falling back to reporting
   * `unconfirmed-exit` instead of the caller's `outcome`.
   */
  async function resolveAfterExitConfirm(outcome: AgentRunOutcome): Promise<void> {
    const confirmed = await pollUntilZero(deps.processTree, deps.wait, confirmTimeoutMs)
    if (confirmed) {
      resolveOutcome(outcome)
      return
    }

    console.warn(
      `agent/agent-run: exit not confirmed after natural ${outcome.kind}, escalating to terminate() before reporting an outcome`,
    )
    const terminateResult = safeTerminate(deps.processTree)
    if (terminateResult instanceof ProcessTreeError) {
      console.warn(
        "agent/agent-run: processTree.terminate() failed while escalating an unconfirmed natural completion:",
        terminateResult.message,
      )
    }

    const reconfirmed = await pollUntilZero(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(reconfirmed ? outcome : { kind: "unconfirmed-exit" })
  }

  async function driveQuery(): Promise<void> {
    const query = deps.queryFn({ prompt: deps.prompt, options: deps.options })
    try {
      for await (const msg of query) {
        if (terminalKind !== null) return // cancel already won the race (late-event drop)

        if ("session_id" in msg && typeof msg.session_id === "string") lastSessionId = msg.session_id

        if (msg.type !== "result") {
          for (const event of normalizeMessage(msg)) queue.push(event)
          continue
        }

        if (!latch("natural")) return // cancel won the race for this exact message

        const events = normalizeMessage(msg)
        for (const event of events) queue.push(event)
        queue.finish()

        if (msg.subtype === "success") {
          await resolveAfterExitConfirm({
            kind: "completed",
            finalText: msg.result,
            usage: deriveUsage(msg),
            sessionId: msg.session_id,
          })
          return
        }
        const errorEvent = events[0]
        const message = errorEvent?.kind === "error" ? errorEvent.message : `unexpected result ${msg.subtype}`
        await resolveAfterExitConfirm({ kind: "backend-error", message, sessionId: msg.session_id })
        return
      }

      // The generator ended cleanly without ever yielding a `result` message
      // (and cancel did not win either) — report it the same as a stream
      // failure so `outcome` still settles instead of hanging forever.
      if (!latch("natural")) return
      const sdkError = new ClaudeSdkError({ code: "STREAM_FAILED", reason: "stream ended without a result message" })
      queue.push({ kind: "error", message: sdkError.message })
      queue.finish()
      await resolveAfterExitConfirm({ kind: "backend-error", message: sdkError.message, sessionId: lastSessionId })
    } catch (cause) {
      // Boundary: `query` is an injected/vendor async generator we do not
      // control — a raw try/catch here (not `errore.try`, which is for sync
      // boundaries) is the errore-sanctioned way to convert an external throw
      // into a value at the lowest call-stack level (mirrors
      // infrastructure/process/model/job-object.ts's FFI boundary).
      if (!latch("natural")) return
      const sdkError = new ClaudeSdkError({
        code: "STREAM_FAILED",
        reason: describeThrown(cause),
        cause: asError(cause),
      })
      queue.push({ kind: "error", message: sdkError.message })
      queue.finish()
      await resolveAfterExitConfirm({ kind: "backend-error", message: sdkError.message, sessionId: lastSessionId })
    }
  }

  // Fire-and-forget: `outcome` must settle even if `events` is never read.
  void driveQuery()

  let cancelPromise: Promise<void> | null = null

  /**
   * turn-durability §6.5's cancel ladder is five rungs: (1) stop non-terminal
   * events + SDK graceful cancel, (2) wait ≤5s, (3) send graceful TREE
   * termination (SIGTERM / Job Object equivalent) and wait ≤5s, (4) hard-kill
   * and wait ≤5s, (5) only then may the caller snapshot/quarantine/reuse.
   *
   * This ladder implements rungs 1, 2, 4 (`abort()` below is rung 1; the
   * first `pollUntilZero` is rung 2; `processTree.terminate()` — a hard
   * `TerminateJobObject`, there is no softer Job Object primitive — plus the
   * second `pollUntilZero` is rung 4) and stops there; rung 5's disposition
   * is the caller's decision, made from this function's outcome. The budget
   * is therefore 10s (2 rungs of ≤5s), not the spec's 15s.
   *
   * DIVERGENCE, ASSESSED AND REJECTED AS UNIMPLEMENTABLE (finding [37]): §6.5
   * names a standalone rung 3 — a genuinely graceful, tree-wide termination
   * attempt distinct from both the SDK abort (rung 1) and the hard
   * job-object kill (rung 4). No such DIFFERENT primitive exists to add on
   * Windows, so per CLAUDE.md's rule (closest faithful mapping + a
   * documented divergence, never a silently invented value) this documents
   * the gap instead of adding an inert rung:
   *   - A Windows Job Object exposes exactly one termination primitive,
   *     `TerminateJobObject` (infrastructure/process/model/job-object.ts) —
   *     Microsoft's own docs for it say a job member cannot postpone or
   *     handle the termination. There is no softer/graceful sibling call.
   *   - The one other handle that could in principle serve rung 3 —
   *     `child.kill('SIGTERM')` on the tree's root `ChildProcess`, spawned
   *     (and never retained past that point) inside `query-fn.ts`'s
   *     `makeSpawnAndAdopt` — would not buy real gracefulness even
   *     if it were retained and wired through here: Node's own
   *     `child_process` docs state that on Windows "the signal argument...
   *     is largely ignored, except for 'SIGKILL', 'SIGTERM', 'SIGINT', and
   *     'SIGQUIT', and the process is always killed forcefully" (the same
   *     unconditional termination as `TerminateProcess`). Retaining that
   *     handle to send `SIGTERM` from here would rename rung 4, not add a
   *     new rung.
   *   - The graceful window §6.5's rung 3 is actually reaching for already
   *     exists one level up, inside the SDK itself, and already runs as part
   *     of rung 1: the installed `@anthropic-ai/claude-agent-sdk` (0.3.212)
   *     closes its process transport on `abortController.abort()` — the same
   *     `AbortController` this file passes in as `Options.abortController`
   *     and aborts on the line below — by first calling `processStdin.end()`
   *     (EOF, the CLI's own graceful-shutdown signal) and only THEN, after a
   *     fixed ~2000ms grace window, considering any escalation at all
   *     (verified by reading the bundled `sdk.mjs`: `ProcessTransport.close()`,
   *     wait constant `wbe = 2000`). That stdin-EOF-plus-~2s sequence fires
   *     before this file's own rung 2 poll or rung 4 kill ever runs — the
   *     spec's rung 3 is functionally already folded into rung 1, not
   *     missing.
   */
  async function runCancelLadder(): Promise<void> {
    deps.abortController.abort(new TurnAbortError({})) // rung 1

    if (!latch("cancelled")) {
      // The run already reached (or is about to reach) a natural terminal
      // outcome, or a previous cancel() already ran — never fight the
      // winner, just wait for whatever it resolved.
      await outcomePromise
      return
    }
    queue.finish() // cancellation carries no AgentEvent — just end the stream.

    const preTerminateConfirmed = await pollUntilZero(deps.processTree, deps.wait, confirmTimeoutMs) // rung 2
    if (preTerminateConfirmed) {
      resolveOutcome({ kind: "cancelled", exitConfirmed: true })
      return
    }

    // rung 4 (hard kill) — rung 3 is the documented gap above.
    const terminateResult = safeTerminate(deps.processTree)
    if (terminateResult instanceof ProcessTreeError) {
      console.warn("agent/agent-run: processTree.terminate() failed during cancel:", terminateResult.message)
    }

    const postTerminateConfirmed = await pollUntilZero(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(postTerminateConfirmed ? { kind: "cancelled", exitConfirmed: true } : { kind: "unconfirmed-exit" })
  }

  function cancel(): Promise<void> {
    if (cancelPromise === null) cancelPromise = runCancelLadder()
    return cancelPromise
  }

  const run: AgentRun = {
    fence: task.fence,
    events: queue.iterable,
    outcome: outcomePromise,
  }

  return { run, cancel }
}

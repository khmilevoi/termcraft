import * as errore from "errore";

import type { AgentRun, AgentRunOutcome } from "agent/types";
import type { TurnFence } from "entities/turn";

import type { NaturalOutcome, RunDeps, RunDriver, RunSink } from "../types";
import { createEventQueue } from "./event-queue";
import { confirmExit, escalateAndConfirm } from "./exit-confirm";

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
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000;

/** How long the engine waits for a driver to return after it has already
 *  claimed an outcome. A driver returns immediately in the normal case; this
 *  bounds the pathological one where the vendor stream's own close never
 *  settles, so `outcome` cannot be held hostage by it. */
const DRIVER_RETURN_GRACE_MS = 2000;

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const queue = createEventQueue(fence);

  let terminalKind: "natural" | "cancelled" | null = null;
  /** Compare-and-swap the termination latch; returns true only for the winner. */
  function latch(kind: "natural" | "cancelled"): boolean {
    if (terminalKind !== null) return false;
    terminalKind = kind;
    return true;
  }

  const { promise: outcomePromise, resolve: resolveOutcome } =
    Promise.withResolvers<AgentRunOutcome>();

  /**
   * Resolves the instant a natural outcome is claimed (i.e. exactly when
   * `latch("natural")` wins inside `sink.complete()` or the driver-threw
   * backstop below) — independent of whether the driver's own `driver(sink)`
   * promise has settled yet. `runDriver()` races the driver's return against
   * this signal plus `DRIVER_RETURN_GRACE_MS` so a driver that claims and then
   * hangs (e.g. a `for await` whose `IteratorClose` never settles) cannot
   * hold `outcome` — and therefore `cancel()` and the backend's `tree.close()`
   * wiring — hostage forever.
   */
  const { promise: claimedSignal, resolve: resolveClaimedSignal } = Promise.withResolvers<void>();

  /**
   * turn-durability §6.4/§6.5: a natural completion must CONFIRM the whole
   * process tree exited before the kernel may retire the fence and snapshot the
   * candidate workspace. If the first poll cannot confirm, escalate exactly like
   * the cancel ladder before falling back to `unconfirmed-exit`.
   */
  async function resolveWithExitConfirm(outcome: AgentRunOutcome): Promise<void> {
    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      resolveOutcome(outcome);
      return;
    }
    console.warn(
      `agent/run: exit not confirmed after natural ${outcome.kind}, escalating to terminate() before reporting an outcome`,
    );
    const reconfirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs);
    resolveOutcome(reconfirmed ? outcome : { kind: "unconfirmed-exit" });
  }

  let claimed: NaturalOutcome | null = null;

  const sink: RunSink = {
    isTerminal: () => terminalKind !== null,
    emit: (event) => {
      if (terminalKind !== null) return; // late-event drop (§6.4)
      queue.push(event);
    },
    complete: (outcome, finalEvents) => {
      if (!latch("natural")) return; // cancel already won (late-event drop, §6.4)
      for (const event of finalEvents ?? []) queue.push(event);
      queue.finish();
      claimed = outcome;
      resolveClaimedSignal();
    },
  };

  /**
   * Drive the vendor driver to completion, without letting a driver that has
   * already claimed an outcome hold `outcome` hostage if its own promise
   * never settles (Fix 1). `driverPromise` is chained with `.catch()` rather
   * than wrapped in try/catch below so it can be raced: it never itself
   * rejects (the catch swallows and logs, errore rule 21), so an abandoned
   * driver settling late is inert rather than an unhandled rejection.
   */
  async function runDriver(): Promise<void> {
    const driverPromise = driver(sink).catch((cause) => {
      // Backstop only: a driver is expected to convert its own boundary throws.
      console.warn("agent/run: driver threw past its own boundary:", describeThrown(cause));
      if (latch("natural")) {
        const driverError = new RunDriverError({ reason: describeThrown(cause), cause });
        queue.push({ kind: "error", message: driverError.message });
        queue.finish();
        claimed = { kind: "backend-error", message: driverError.message, sessionId: null };
        resolveClaimedSignal();
      }
    });

    // Wait for whichever comes first: the driver actually returning, or —
    // once it has claimed an outcome via `complete()` — the bounded grace
    // period. A driver that returns promptly (the normal case) settles
    // `driverPromise` well before any grace timer would matter, so this adds
    // no observable delay. `deps.wait`'s rejection is guarded the same way
    // `exit-confirm.ts`'s `safeWait` guards it: an injected `wait` is
    // documented "never rejects", but a misbehaving one must not turn into an
    // unhandled rejection out of a fire-and-forget `void runDriver()`.
    await Promise.race([
      driverPromise,
      claimedSignal.then(() =>
        deps.wait(DRIVER_RETURN_GRACE_MS).catch((cause) => {
          console.warn(
            "agent/run: injected wait() rejected during the driver-return grace period:",
            describeThrown(cause),
          );
        }),
      ),
    ]);

    if (claimed === null && latch("natural")) {
      // The driver returned without claiming an outcome and without cancel
      // winning — report it as a failure so `outcome` still settles.
      const message = "agent run ended without a terminal outcome";
      queue.push({ kind: "error", message });
      queue.finish();
      claimed = { kind: "backend-error", message, sessionId: null };
    }

    if (claimed !== null) await resolveWithExitConfirm(claimed);
  }

  // Fire-and-forget: `outcome` must settle even if `events` is never read.
  void runDriver();

  let cancelPromise: Promise<void> | null = null;

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
   * DIVERGENCE, ASSESSED AND REJECTED AS UNIMPLEMENTABLE: §6.5 names a
   * standalone rung 3 — a genuinely graceful, tree-wide termination attempt
   * distinct from both the SDK abort (rung 1) and the hard job-object kill
   * (rung 4). No such DIFFERENT primitive exists to add on Windows, so per
   * CLAUDE.md's rule (closest faithful mapping + a documented divergence,
   * never a silently invented value) this documents the gap instead of
   * adding an inert rung:
   *   - A Windows Job Object exposes exactly one termination primitive,
   *     `TerminateJobObject` (infrastructure/process/model/job-object.ts) —
   *     Microsoft's own docs for it say a job member cannot postpone or
   *     handle the termination. There is no softer/graceful sibling call.
   *   - The one other handle that could in principle serve rung 3 —
   *     `child.kill('SIGTERM')` on the tree's root `ChildProcess`, spawned
   *     (and never retained past that point) inside `spawn-adopt.ts`'s
   *     `createSpawnAndAdopt` — would not buy real gracefulness even
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
   *     `AbortController` this file aborts on the line below, which
   *     `RunDeps.abortController`'s doc comment (`../types.ts`) requires the
   *     driver's own vendor call to be wired to observe. This file never sees
   *     `Options` itself — the vendor backend (for Claude,
   *     `agent/claude/backend/model/backend.ts`) is what passes this same
   *     controller into the SDK as `Options.abortController` — by first
   *     calling `processStdin.end()` (EOF, the CLI's own graceful-shutdown
   *     signal) and only THEN, after a fixed ~2000ms grace window, considering
   *     any escalation at all
   *     (verified by reading the bundled `sdk.mjs`: `ProcessTransport.close()`,
   *     wait constant `wbe = 2000`). That stdin-EOF-plus-~2s sequence fires
   *     before this file's own rung 2 poll or rung 4 kill ever runs — the
   *     spec's rung 3 is functionally already folded into rung 1, not
   *     missing.
   */
  async function runCancelLadder(): Promise<void> {
    deps.abortController.abort(new TurnAbortError({})); // rung 1

    if (!latch("cancelled")) {
      // A natural outcome already won, or a previous cancel() already ran —
      // never fight the winner, just wait for whatever it resolved.
      await outcomePromise;
      return;
    }
    queue.finish(); // cancellation carries no AgentEvent — just end the stream.

    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      // rung 2
      resolveOutcome({ kind: "cancelled", exitConfirmed: true });
      return;
    }

    // rung 4 (hard kill) — rung 3 is the documented gap above.
    const confirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs);
    resolveOutcome(
      confirmed ? { kind: "cancelled", exitConfirmed: true } : { kind: "unconfirmed-exit" },
    );
  }

  function cancel(): Promise<void> {
    if (cancelPromise === null) cancelPromise = runCancelLadder();
    return cancelPromise;
  }

  const run: AgentRun = { fence, events: queue.iterable, outcome: outcomePromise };
  return { run, cancel };
}

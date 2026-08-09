import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import type { PublishableEventV1, TurnBackendLeaseV1 } from "core/mailbox";
import type {
  AgentBackend,
  AgentRunOutcome,
  AgentTask,
  BackendErrorCause,
  FencedEvent,
} from "core/ports";
import type { CommandRejectionCode, EventPayloadByKindV1 } from "core/protocol";
import type { TokenUsage } from "entities/turn";
import { trace } from "infrastructure/debug-log";

import type { TurnDeadlines } from "./deadlines";
import type { TurnFence, TurnFenceError } from "./fence";

/**
 * `kernel.turn.beginAttempt` / `beginStopping` / `requestCancel` — `workspace-ready ->
 * running -> stopping` (kernel-command-contract §7.2 lines 234/236; §12.2 items 2-5).
 *
 * ENTRY AND EXIT ONLY, NOT THE FORK BEYOND IT: matching `finalize.ts`'s and
 * `terminalize.ts`'s own documented pattern (see their headers), this file's arc ends at
 * `stopping` — it never drives `beginSnapshot` / `beginTerminalization` /
 * `markBackendUnhealthy` itself. Which of those three legally follows depends entirely on
 * THIS function's own returned {@link TurnAttemptOutcomeV1}, and applying that fork is
 * "whichever caller decided" it (`terminalize.ts`'s own phrase for the identical shape of
 * decision) — not this file's job.
 *
 * CRITICAL ORDERING (kernel-command-contract §12.2 item 5 / turn-durability §6.4), both
 * provable with ordered fake call logs:
 *
 * (a) A cancellation request enters `stopping` immediately (`requestCancel`) and asks the
 *     `AgentBackend` port to terminate the exact leased run; the returned promise does not
 *     settle until that exit is CONFIRMED — `AgentBackend.cancel`'s own contract: "resolves
 *     only after confirmed exit" (or the run reports it could not confirm one). "A later
 *     turn cannot start while cancellation is incomplete" falls out for free: nothing in
 *     this module — or the caller awaiting `requestCancel()` — can observe a settled
 *     cancellation before that confirmation lands.
 * (b) The fence is RETIRED the moment ANY outcome (natural or cancelled) is known — strictly
 *     before this function's caller can ever freeze a candidate for this attempt, since a
 *     caller only ever calls `candidate.ts` after `outcome` resolves, and retirement is the
 *     very first thing the resolved value's continuation does.
 */

type TurnAttemptStartedPayloadV1 = EventPayloadByKindV1["turn.attemptStarted"];
type TurnProgressPayloadV1 = EventPayloadByKindV1["turn.progress"];

export interface TurnAttemptDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly agentBackend: AgentBackend;
  readonly deadlines: TurnDeadlines;
  readonly publish: (
    event: PublishableEventV1<"turn.attemptStarted"> | PublishableEventV1<"turn.progress">,
  ) => void;
}

export interface TurnAttemptInputV1 {
  readonly turnId: string;
  readonly fence: TurnFence;
  /** Everything `AgentTask` needs except `fence` — this module mints and attaches that itself. */
  readonly task: Omit<AgentTask, "fence">;
}

export type TurnAttemptOutcomeV1 =
  | {
      readonly kind: "completed";
      readonly finalText: string;
      readonly usage: TokenUsage | null;
      readonly sessionId: string;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly sessionId: string | null;
      /** Carried straight from `AgentRunOutcome`'s `backend-error.cause` — see that type's doc. */
      readonly cause: BackendErrorCause;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "backend-unhealthy" };

export interface TurnAttemptHandle {
  readonly outcome: Promise<TurnAttemptOutcomeV1>;
  /** Requests cancellation. Does not resolve until exit is confirmed — see ordering (a) above. */
  readonly requestCancel: () => Promise<void>;
}

export type TurnAttemptStartResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "started"; readonly handle: TurnAttemptHandle };

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toAttemptOutcome(raw: AgentRunOutcome): TurnAttemptOutcomeV1 {
  if (raw.kind === "completed")
    return {
      kind: "completed",
      finalText: raw.finalText,
      usage: raw.usage,
      sessionId: raw.sessionId,
    };
  if (raw.kind === "backend-error")
    return { kind: "failed", message: raw.message, sessionId: raw.sessionId, cause: raw.cause };
  if (raw.kind === "cancelled") return { kind: "cancelled" };
  return { kind: "backend-unhealthy" }; // AgentRunOutcome's remaining case, "unconfirmed-exit".
}

/**
 * `AgentBackend` (lifted verbatim from `agent/types.ts`) stamps every event with
 * `entities/turn`'s plain `{turnId: string, attempt, leaseNonce}` fence shape — it predates
 * this slice's UUIDv7-branded `TurnBackendLeaseV1` (`core/mailbox`) `fence.ts`'s `accepts`
 * compares against. The two are the exact same three fields at runtime; this bridges the
 * brand so the ALREADY-LANDED comparison (never reimplemented here) can run against it.
 */
function asLease(fence: FencedEvent["fence"]): TurnBackendLeaseV1 {
  return fence as TurnBackendLeaseV1;
}

/** `entities/turn`'s `AgentEvent` mirrors `turn.progress`'s payload content field for field (see `event-payload.ts`'s own note); this is that mirror, named for the target shape. */
function toProgressContent(event: FencedEvent["event"]): TurnProgressPayloadV1["content"] {
  return event;
}

/**
 * Starts one attempt through the `AgentBackend` port: mints the next lease, pumps the run's
 * events (emitting `turn.attemptStarted` then `turn.progress` per valid fenced event,
 * feeding `deadlines.noteEvent` on each), and resolves once the attempt's outcome is known
 * — retiring the fence first (ordering (b) above). Returns synchronously with a live handle;
 * the caller may `requestCancel()` at any point before `outcome` settles.
 */
export function startTurnAttempt(
  deps: TurnAttemptDeps,
  input: TurnAttemptInputV1,
): TurnFenceError | TurnAttemptStartResultV1 {
  const began = deps.machine.apply("beginAttempt");
  if (began.kind === "illegal") return { kind: "illegal", code: began.code };

  const lease = input.fence.beginAttempt();
  if (lease instanceof Error) return lease;

  const fullTask: AgentTask = { ...input.task, fence: lease };

  // DIAGNOSTIC (infrastructure/debug-log): the attempt this fence just minted -- turnId, attempt
  // number, and the outgoing user message length -- before anything downstream can fail.
  trace("core.turns.attempt.started", {
    turnId: input.turnId,
    attempt: lease.attempt,
    userMessageLength: input.task.userMessage.length,
  });

  // Captured ONCE here, inside the caller's active Reatom context — mirrors
  // `core/mailbox/model/dispatch.ts`'s "wrap captured once, not fresh per call": both
  // continuations below may run one or more microtasks after an `await` (the event pump's
  // per-item resumption; the outcome's `.then`), where the ambient context would otherwise
  // be lost.
  const handleFencedEvent = wrap((fencedEvent: FencedEvent) => {
    if (!input.fence.accepts(asLease(fencedEvent.fence))) {
      console.warn(
        `core/turns/attempt: dropping a stale event for turn ${input.turnId} attempt ${lease.attempt}`,
      );
      // DIAGNOSTIC (infrastructure/debug-log): a stale event dropped by the fence check -- the
      // console.warn above is already mirrored into the trace file by the console tee, but this gives
      // the drop its own greppable channel alongside the rest of this attempt's own trace.
      trace("core.turns.attempt.eventDropped", { turnId: input.turnId, attempt: lease.attempt });
      return;
    }
    deps.deadlines.noteEvent();
    const payload: TurnProgressPayloadV1 = {
      turnId: lease.turnId,
      attempt: lease.attempt,
      content: toProgressContent(fencedEvent.event),
    };
    deps.publish({ kind: "turn.progress", payload, correlation: { turnId: lease.turnId } });
  });

  // Set only by `requestCancel`, so the natural-completion path below knows whether
  // `requestCancel` already drove `running -> stopping` itself (in which case calling
  // `beginStopping` afterward would be a redundant, illegal same-state call).
  let cancelRequested = false;

  const finalizeOutcome = wrap((raw: AgentRunOutcome): TurnAttemptOutcomeV1 => {
    if (!cancelRequested) {
      const stopped = deps.machine.apply("beginStopping");
      if (stopped.kind === "illegal") {
        console.warn(
          `core/turns/attempt: beginStopping illegal (${stopped.code}) for turn ${input.turnId}`,
        );
      }
    }
    // Ordering (b): retire strictly before the caller can ever freeze a candidate for
    // this attempt.
    input.fence.retire();
    const outcome = toAttemptOutcome(raw);
    // DIAGNOSTIC (infrastructure/debug-log): the attempt final outcome as the turn spine sees it --
    // completed/failed/cancelled/backend-unhealthy -- ties this attempt generation work to what
    // core/turns/model/run-turn.ts does with it next.
    trace("core.turns.attempt.outcome", { turnId: input.turnId, attempt: lease.attempt, outcome });
    return outcome;
  });

  const run = deps.agentBackend.startTurn(fullTask);

  deps.deadlines.noteAttemptStarted();
  const startedPayload: TurnAttemptStartedPayloadV1 = {
    turnId: lease.turnId,
    attempt: lease.attempt,
    deadline: new Date(deps.deadlines.absoluteDeadlineAt()).toISOString(),
  };
  deps.publish({
    kind: "turn.attemptStarted",
    payload: startedPayload,
    correlation: { turnId: lease.turnId },
  });

  async function pump(): Promise<void> {
    for await (const fencedEvent of run.events) {
      handleFencedEvent(fencedEvent);
    }
  }
  // Fire-and-forget: `outcome` must settle whether or not anything drives this loop to
  // completion on its own — matching `agent/run/model/engine.ts`'s identical `void
  // runDriver()` note. A rejection here is a producer bug in the port, logged rather than
  // left as an unhandled rejection.
  void pump().catch((cause) => {
    console.warn(
      `core/turns/attempt: event pump failed for turn ${input.turnId} attempt ${lease.attempt}:`,
      describeThrown(cause),
    );
  });

  const outcome = run.outcome.then(finalizeOutcome);

  const requestCancel = wrap((): Promise<void> => {
    if (!cancelRequested) {
      cancelRequested = true;
      const cancelled = deps.machine.apply("requestCancel");
      if (cancelled.kind === "illegal") {
        console.warn(
          `core/turns/attempt: requestCancel illegal (${cancelled.code}) for turn ${input.turnId}`,
        );
      }
    }
    return deps.agentBackend.cancel(run);
  });

  return { kind: "started", handle: { outcome, requestCancel } };
}

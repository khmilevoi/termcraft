import type { SessionCheckpointService, SessionPlan } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";

import type { TurnDeadlines } from "./deadlines";

/**
 * The resume-or-fresh decision through the `SessionCheckpointService` port
 * (storage-identity §6.2), the session-fallback path a rejected resume falls back to, and
 * advancing the checkpoint once a terminal outcome is durable.
 *
 * NONE of these three functions touch Reatom — `SessionCheckpointService` is a plain async
 * port and `TurnDeadlines` (`deadlines.ts`) is plain closures (see that file's own header),
 * so no `wrap(...)` is needed here (matching `core/project/model/trust.ts`'s identical
 * no-Reatom-touch reasoning) — a continuation only needs `wrap` when it re-enters Reatom
 * after the await, and nothing below ever does.
 *
 * SESSION FALLBACK, NOT SESSION PLANNING: `fallbackToFreshSession` is deliberately a
 * SEPARATE entry point from `evaluateSessionPlan`, not a second branch inside it.
 * `evaluateSessionPlan`'s own "fresh" branch (the checkpoint comparison ITSELF resolving
 * "fresh") is not fallback activity — the turn has not attempted anything yet. A fallback
 * happens LATER, when a resume the checkpoint judged legitimate is then rejected by the
 * backend itself (storage-identity §6.2: "...or an SDK resume rejection is a mismatch");
 * that is genuine mid-turn activity, which is why only THIS path calls
 * `deadlines.noteSessionFallback()` — resetting the stream-silence watchdog, never the
 * absolute deadline (`deadlines.ts` already guarantees the non-resettable half; this module
 * never reimplements or works around it, per this slice's binding rule).
 */

export interface EvaluateSessionPlanDeps {
  readonly sessionCheckpoint: SessionCheckpointService;
}

export interface EvaluateSessionPlanInputV1 {
  readonly chatId: string;
  readonly sessionScopeId: string;
}

/**
 * §6.2's resume-vs-fresh decision: compare the stored checkpoint against the chat's current
 * state, and only build a seed (`selectSeed`) when the comparison itself resolves "fresh" —
 * a resume verdict never needs one.
 */
export async function evaluateSessionPlan(
  deps: EvaluateSessionPlanDeps,
  input: EvaluateSessionPlanInputV1,
): Promise<FailureDtoV1 | SessionPlan> {
  const verdict = await deps.sessionCheckpoint.evaluateResume(input);
  if ("code" in verdict) return verdict;
  if (verdict.kind === "resume")
    return { kind: "resume", sessionId: verdict.sessionId, promptDelta: verdict.promptDelta };

  const seed = await deps.sessionCheckpoint.selectSeed(input.chatId);
  if ("code" in seed) return seed;
  return { kind: "fresh", seed };
}

export interface SessionFallbackDeps {
  readonly sessionCheckpoint: SessionCheckpointService;
  readonly deadlines: TurnDeadlines;
}

/**
 * Builds a fresh-session plan after a resume the checkpoint judged legitimate was rejected
 * by the backend itself, and notes the fallback on `deadlines` — see this file's header.
 * The deadline note runs only AFTER `selectSeed` succeeds: a failed seed selection is not
 * turn activity worth resetting silence for, and the caller gets the failure to handle
 * (likely terminalizing the turn), not a plan.
 */
export async function fallbackToFreshSession(
  deps: SessionFallbackDeps,
  chatId: string,
): Promise<FailureDtoV1 | SessionPlan> {
  const seed = await deps.sessionCheckpoint.selectSeed(chatId);
  if ("code" in seed) return seed;

  deps.deadlines.noteSessionFallback();
  return { kind: "fresh", seed };
}

export interface AdvanceSessionCheckpointDeps {
  readonly sessionCheckpoint: SessionCheckpointService;
}

export interface AdvanceSessionCheckpointInputV1 {
  readonly chatId: string;
  readonly sessionScopeId: string;
  readonly sessionId: string;
}

/** §6.2: after the terminal agent outcome is durably appended, atomically advance the checkpoint to the prefix the backend session now reflects. */
export async function advanceSessionCheckpoint(
  deps: AdvanceSessionCheckpointDeps,
  input: AdvanceSessionCheckpointInputV1,
): Promise<FailureDtoV1 | undefined> {
  return deps.sessionCheckpoint.advanceCheckpoint(input);
}

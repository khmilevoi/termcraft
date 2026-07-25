import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState, TurnTerminalOutcome } from "core/machines";
import type {
  StagingService,
  TurnCommitV1,
  TurnTerminalRecordV1,
  TurnTransactionService,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

/**
 * `kernel.turn.finishTerminalization` / `settle` — `terminalizing -> terminal -> idle`
 * (kernel-command-contract §7.2 lines 261-262).
 *
 * ENTRY POINT, NOT THE EDGE INTO IT: this file assumes the machine is ALREADY in
 * `terminalizing` — reached via `beginStopping`+`beginTerminalization`,
 * `beginTerminalization` alone, or `requestCancel`, none of which this file drives (those
 * edges belong to whichever caller decided the turn must terminalize, e.g.
 * `finalize.ts`'s own CAS-mismatch/deadline-exceeded failure path, which returns a
 * `{kind:"failed"}` result rather than touching this file's edge itself — see that file's
 * header). §7.2's own phrase for terminalize.ts's scope is "stopping/validating/finalizing
 * -> terminalizing -> terminal -> idle": the first three are SOURCES of the edge INTO
 * `terminalizing`, not states this file's own actions touch.
 *
 * MUTEX: same reasoning as `finalize.ts` — turn-durability §7.6's "the terminalization path
 * acquires the project-write mutex, re-snapshots the current complete valid chat prefix..."
 * describes `TurnTransactionService.terminalize`'s own internal adapter behavior (that
 * port's doc: "MUTEX/PERMIT ARE ABSENT FROM EVERY METHOD HERE"). No `ProjectWriteCoordinator`
 * here.
 *
 * RECORDED VS UNRECORDED: §7.2's `finishTerminalization` row requires "exactly one terminal
 * chat record OR A TYPED UNRECORDED RECOVERY CONDITION" — the coarse transition table has
 * no precondition tied to whether the append itself succeeded (matching `retryAfterGate`'s
 * attempt-budget precondition, likewise absent from the table). So this function calls
 * `finishTerminalization` unconditionally once the phase check passes, attempts the append,
 * and ALWAYS proceeds to `settle` regardless of the append's outcome — turn-durability
 * §7.5's own words for the append-failure case: "the UI reports the unrecorded stale turn
 * and startup orphan recovery retries terminalization without changing design state." A
 * turn must not get stuck outside `terminal` merely because its own failure record could
 * not be written; `unrecorded` is exactly that reported condition, for the caller/orphan
 * scan to pick up later — never a thrown/swallowed error.
 *
 * CANDIDATE RETIREMENT (kernel-assembly Task 13): `settle` is applied unconditionally
 * above — so the frozen candidate directory (`StagingService.retireCandidate`) is retired
 * unconditionally too, right after `settle`, whether the terminal record ended up recorded
 * or unrecorded: either way the turn is DONE and the candidate is no longer needed. A
 * retire failure is REPORTED via `console.warn`, never propagated — matching `finalize.ts`'s
 * identical reasoning ("the turn's outcome is already durable by then"). `staging` is
 * REQUIRED (review finding #4 — matching `finalize.ts`'s identical fix: an optional
 * dependency here was never actually threaded through by any real caller, silently
 * reopening the candidate leak this task closed): `core/turns/model/run-turn.ts` is the one
 * production driver, and it always has a real `StagingService` on its own `RunTurnDeps`.
 * `candidateRoot` stays OPTIONAL, unlike `finalize.ts`'s own now-required field — CORRECTED
 * (review finding #4, second half): the one legitimate skip is "no candidate has EVER been
 * frozen for THIS TURN yet", not merely "THIS attempt never froze one". An earlier version of
 * this comment described the skip as firing for "a very early cancellation before
 * `freezeTurnCandidate` ever ran" as if that were the only case — false once retries exist,
 * since a gate-triggered retry (`validation.ts`'s `"retry"` result) leaves an EARLIER
 * attempt's candidate live before looping back for another attempt. `run-turn.ts`'s own
 * `runTurn` now hoists its `candidateRoot` binding above the whole per-attempt retry loop
 * specifically so a retry that then gets cancelled/fails/times out BEFORE ITS OWN freeze
 * still passes the PRIOR attempt's already-frozen root here, rather than omitting it just
 * because the CURRENT attempt never froze one. So `candidateRoot` legitimately reaches this
 * function `null`/absent only when a turn is cancelled/fails/expires, or its own freeze
 * itself fails, on attempt 1 before ANY freeze in the turn ever succeeded — in which case
 * retirement is silently skipped (no candidate ever existed — nothing to warn about).
 */

export interface TerminalizeTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly turnTransactions: TurnTransactionService;
  /** See this file's header, "CANDIDATE RETIREMENT". */
  readonly staging: StagingService;
}

export interface TerminalizeTurnInputV1 {
  readonly turnId: string;
  readonly targetChatId: string;
  readonly outcome: TurnTerminalOutcome;
  readonly text: string;
  /** Only meaningful for a `system:error` record (e.g. `"process_restart_before_intent"`). */
  readonly reason?: string;
  readonly createdAt: string;
  /** The frozen candidate's own root (`TurnCandidateV1.root`) to retire — `null`/absent when none was ever frozen. See `TerminalizeTurnDeps.staging`. */
  readonly candidateRoot?: string | null;
}

/**
 * `outcome`/`reason` on the `"recorded"`/`"unrecorded"` variants (WP-8 item 4 follow-up —
 * gate-exhaustion-vs-backend-failure indistinguishability): the ORIGINALLY REQUESTED
 * {@link TurnTerminalOutcome} and this call's own `TerminalizeTurnInputV1.reason`, echoed back
 * verbatim rather than discarded. Before this, `"recorded"` carried only an opaque
 * `TurnCommitV1` (`{transactionId: string}`) and `"unrecorded"` only the append failure itself
 * — neither said WHICH outcome/reason the caller passed in, so `handlers/turn.ts` (the one
 * production caller, via `run-turn.ts`'s `terminalize()` helper) could not honestly rebuild a
 * `turn.failed` `failure.code` more specific than a fabricated `PERSISTENCE_FAILED` bucket, even
 * though `run-turn.ts` already passes a real `OperationalFailureCode` string as `reason` for
 * several call sites (e.g. Gate exhaustion's `"GATE_RETRY_EXHAUSTED"`). `reason` stays the same
 * loosely-typed `string | undefined` `TerminalizeTurnInputV1.reason` already is (it is also used
 * for non-operational-failure tokens like `"unhealthy_unconfirmed_exit"`); the caller is the one
 * that narrows it with `isOperationalFailureCode` before trusting it as a wire failure code —
 * see `handlers/turn.ts`'s own header.
 */
export type TerminalizeTurnResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | {
      readonly kind: "recorded";
      readonly commit: TurnCommitV1;
      readonly outcome: TurnTerminalOutcome;
      readonly reason?: string;
    }
  | {
      readonly kind: "unrecorded";
      readonly failure: FailureDtoV1;
      readonly outcome: TurnTerminalOutcome;
      readonly reason?: string;
    };

/**
 * §7.2 verbatim: "`failed` persists as a `system:error` record with typed outcome
 * `error`; `cancelled` persists as `system:cancelled`; `stale` and `interrupted` persist
 * as `system:error` records with the same-named outcomes." `turnId` is always set,
 * `actionId` always absent — this is a TURN terminalization, never a standalone action.
 */
function buildTerminalRecord(input: TerminalizeTurnInputV1): TurnTerminalRecordV1 {
  const recordId = uuidv7();

  if (input.outcome === "cancelled") {
    return {
      kind: "system:cancelled",
      recordId,
      turnId: input.turnId,
      text: input.text,
      ts: input.createdAt,
    };
  }

  // "failed" is the one outcome whose record-level name DIFFERS from the outcome name
  // (§7.2: "typed outcome `error`", not "failed") — "stale"/"interrupted" pass through
  // under their own name.
  const outcome: "error" | "stale" | "interrupted" =
    input.outcome === "failed" ? "error" : input.outcome;
  return {
    kind: "system:error",
    recordId,
    turnId: input.turnId,
    outcome,
    reason: input.reason,
    text: input.text,
    ts: input.createdAt,
  };
}

/**
 * Retires the frozen candidate once known (see this file's header, "CANDIDATE RETIREMENT").
 * `staging` is required (review finding #4) — this call site no longer needs a defensive
 * "missing dependency" branch at all. `candidateRoot` legitimately absent (no candidate has
 * EVER been frozen for this turn yet — see this file's header for why that is "for this
 * turn", not merely "for this attempt") is the one remaining silent no-op — nothing to warn
 * about, since no candidate ever existed. A real retire failure is logged, never propagated:
 * by the time this runs the turn is already reaching its own terminal outcome.
 */
async function retireIfCandidateFrozen(
  staging: StagingService,
  candidateRoot: string | null | undefined,
): Promise<void> {
  if (candidateRoot === null || candidateRoot === undefined) return;
  const retired = await wrap(staging.retireCandidate(candidateRoot));
  if (retired !== undefined)
    console.warn("terminalizeTurn: candidate retirement failed:", retired.safeMessage);
}

export async function terminalizeTurn(
  deps: TerminalizeTurnDeps,
  input: TerminalizeTurnInputV1,
): Promise<TerminalizeTurnResultV1> {
  const finished = deps.machine.apply("finishTerminalization");
  if (finished.kind === "illegal") return { kind: "illegal", code: finished.code };

  const record = buildTerminalRecord(input);
  const result = await wrap(
    deps.turnTransactions.terminalize({
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      record,
      createdAt: input.createdAt,
    }),
  );

  // Unconditional: §7.2 allows this edge on EITHER a recorded outcome or a typed
  // unrecorded condition — see this file's header.
  deps.machine.apply("settle");

  // The turn is DONE either way now — see this file's header, "CANDIDATE RETIREMENT".
  await retireIfCandidateFrozen(deps.staging, input.candidateRoot);

  if ("code" in result) {
    return { kind: "unrecorded", failure: result, outcome: input.outcome, reason: input.reason };
  }
  return { kind: "recorded", commit: result, outcome: input.outcome, reason: input.reason };
}

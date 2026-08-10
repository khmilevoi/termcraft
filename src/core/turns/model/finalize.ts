import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import { type SentPinV1, resolveSentPinAppends } from "core/pins/model/turn-resolution";
import type {
  ChangedDesignFileOpV1,
  StagedTurnReadSetV1,
  StagingService,
  TurnCommitV1,
  TurnTransactionService,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol";
import type { ChatAgentRecord } from "entities/chat";
import type { PageSlug } from "entities/page";
import { log, trace } from "infrastructure/debug-log";

import type { TurnDeadlines } from "./deadlines";
import { toFinalizeReadSet } from "./read-set";

/**
 * `kernel.turn.beginFinalization` / `markCommitted` / `settle` — the turn's SUCCESS arc,
 * `validating -> finalizing -> committed -> idle` (kernel-command-contract §7.2 lines
 * 256/258/260; §12.2 item 7).
 *
 * MUTEX: this function does NOT take a `ProjectWriteCoordinator`. `ProjectWritePermit`
 * (`core/ports/project-write.ts`) is documented as Export's own short-lease mechanism
 * ("Export uses it only to capture one coherent source/settings snapshot" — KCC's own
 * glossary); a turn's finalize mutex/CAS-revalidation/intent sequence (turn-durability
 * §4.3 steps 1-9, §7.5) is entirely internal to `TurnTransactionService.finalize`'s real
 * adapter (`turn-transactions.ts`'s own header: "MUTEX/PERMIT ARE ABSENT FROM EVERY METHOD
 * HERE ... `store`'s real `TransactionEngine` already acquires and releases its own
 * `WriteMutex` permit internally around each call"). Acquiring `ProjectWriteCoordinator`
 * here too would not be a second mutex (the port exposes the SAME instance) but WOULD
 * deadlock against the adapter's own internal acquisition, since a FIFO-fair mutex is not
 * re-entrant. So this module's only precondition work is what the port cannot see for
 * itself: the KERNEL-owned turn deadline (`deadlines.ts`) and the staged-to-finalize
 * read-set translation (`read-set.ts`).
 *
 * DEADLINE: "Re-check the landed deadlines ... before committing intent" (roadmap
 * ordering) — checked AFTER `beginFinalization` succeeds but BEFORE `turnTransactions
 * .finalize` is ever called, so an expired turn never reaches durable commit intent.
 *
 * COMMITTED IS POST-HOC ONLY: §7.2 "Legal only after durable committed marker; after
 * intent, cancellation is forbidden and recovery rolls forward" — `markCommitted` runs
 * ONLY once `turnTransactions.finalize` has ITSELF returned a `TurnCommitV1`, never
 * speculatively before that call resolves.
 *
 * OUT OF SCOPE: the `finalizing -> terminalizing` edge on a CAS-mismatch/deadline-exceeded
 * failure (§7.2 line 259) is deliberately NOT driven here — this file's own arc ends at
 * "validating -> finalizing -> committed -> idle"; `terminalizing` is `terminalize.ts`'s
 * own entry phase (its header explains why), reached by a caller this function does not
 * own once it inspects this function's `{kind:"failed", failure}` result.
 *
 * CANDIDATE RETIREMENT (kernel-assembly Task 13): once `markCommitted`/`settle` both
 * succeed the turn's outcome is already durable, so this function retires the frozen
 * candidate directory (`StagingService.retireCandidate`) exactly once, right before
 * returning `{kind:"committed"}` — never on the `{kind:"illegal"}`/`{kind:"failed"}` exits,
 * since those never reach a committed outcome (a CAS-mismatch/deadline failure instead
 * bridges into `terminalizing`, where `terminalize.ts`'s own call retires it later). A
 * retire failure is REPORTED via `log.warn`, never propagated: the turn's outcome does
 * not retroactively fail over a cleanup problem (errore rule: an error that is not
 * propagated must still leave a trace). `staging` is REQUIRED (review finding #4 — an
 * optional dependency here was never actually threaded through by any real caller, silently
 * reopening the candidate leak this task closed): `core/turns/model/run-turn.ts` is the one
 * production driver, and it always has a real `StagingService` on its own `RunTurnDeps`
 * (`RunTurnDeps.staging`, required there too). `candidateRoot` is likewise REQUIRED on
 * `FinalizeTurnInputV1` below — `run-turn.ts` only ever calls this function once a candidate
 * has ALREADY been frozen (`freezeTurnCandidate`'s own `candidate.root`), so there is never a
 * legitimate finalize call with no candidate to retire.
 */

export interface FinalizeTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly turnTransactions: TurnTransactionService;
  readonly deadlines: TurnDeadlines;
  /** See this file's header, "CANDIDATE RETIREMENT". */
  readonly staging: StagingService;
  /**
   * Fired the INSTANT `settle` applies and the machine is back in `idle` — before this function's
   * own post-settle candidate retirement (fix-bundle spec §1.5). The Kernel's `activeTurnId`
   * clears here and nowhere else: clearing it after `finalizeTurn`/`runTurn` resolves left a
   * window where `phase === "idle"` still carried the finished turn's id, so a new `turn.start`
   * passed the guard and the OLD handler then cleared the NEW turn's id. Optional and additive,
   * mirroring `RunTurnDeps.onAttemptStarted`'s own producer-hook shape.
   */
  readonly onSettled?: () => void;
}

export interface FinalizeTurnInputV1 {
  readonly turnId: string;
  readonly targetChatId: string;
  /** Gate-validated diff over tree-relative paths; empty means no design file changed (§7.4 item 5). */
  readonly changedFiles: readonly ChangedDesignFileOpV1[];
  /** The slugs whose CLOSURE changed this turn (design §7) — the pin-resolution filter; see `core/ports`' `TurnFinalizeInputV1.changedPageSlugs` for the full rationale. Derived by the caller from the closure diff (`selectChangedPages`), never from a file path. */
  readonly changedPageSlugs: readonly PageSlug[];
  readonly requestedActivePage?: PageSlug | null;
  readonly agentRecord: ChatAgentRecord;
  /** The turn's admission-time captured pin set (§12.2 item 1) — turn-resolution.ts's only pin source. */
  readonly sentPins: readonly SentPinV1[];
  readonly stagedReadSet: StagedTurnReadSetV1;
  readonly createdAt: string;
  /** The frozen candidate's own root (`TurnCandidateV1.root`) to retire on commit — always present: this function is only ever called once a candidate has been frozen. See `FinalizeTurnDeps.staging`. */
  readonly candidateRoot: string;
}

/**
 * WHICH machine transition was refused — the field that tells a caller whether a durable commit
 * exists (defect fix, 2026-07-26).
 *
 * `"beginFinalization"` is refused BEFORE `turnTransactions.finalize` is ever called, so nothing
 * was written: no commit, no page bytes, no chat record. `"markCommitted"`/`"settle"` are refused
 * only AFTER that call has already returned a durable `TurnCommitV1`.
 *
 * Without this discriminator `run-turn.ts` collapsed both into one message — "the turn's commit
 * landed durably, but the turn machine could not settle onto it" — which it then wrote verbatim
 * into the chat as a `system:error` record. Cancelling during Gate validation reaches the FIRST
 * case (`requestCancel` is legal from `validating`, so the machine has already left it by the
 * time validation returns), so pressing Esc told the user their edit had been committed durably
 * when nothing at all had been written.
 */
export type FinalizeIllegalAtV1 = "beginFinalization" | "markCommitted" | "settle";

export type FinalizeTurnResultV1 =
  | {
      readonly kind: "illegal";
      readonly code: CommandRejectionCode;
      readonly at: FinalizeIllegalAtV1;
    }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "committed"; readonly commit: TurnCommitV1 };

function deadlineExceededFailure(bound: "stream-silence" | "absolute"): FailureDtoV1 {
  return {
    code: "TURN_DEADLINE_EXCEEDED",
    retryable: false,
    safeMessage: "the turn's deadline expired before finalization intent could be written",
    details: { bound },
  };
}

/**
 * Retires the frozen candidate (see this file's header, "CANDIDATE RETIREMENT"). Both
 * arguments are required — a retire failure is logged, never propagated: by the time this
 * runs the turn's own outcome is already durable.
 */
async function retireFinalizedCandidate(
  staging: StagingService,
  candidateRoot: string,
): Promise<void> {
  const retired = await wrap(staging.retireCandidate(candidateRoot));
  if (retired !== undefined)
    log.warn("finalizeTurn: candidate retirement failed:", retired.safeMessage);
}

function translationFailure(reason: string): FailureDtoV1 {
  // Not one of §11.2's typed CAS codes — a malformed staged read set (a duplicate page
  // slug) is an internal invariant violation, not a business drift the CAS vocabulary
  // names. `PERSISTENCE_FAILED` is this ring's own established mapping for that class
  // (`core/project/model/page-mutations.ts`'s identical use for a ledger-drift Error).
  return { code: "PERSISTENCE_FAILED", retryable: false, safeMessage: reason, details: {} };
}

export async function finalizeTurn(
  deps: FinalizeTurnDeps,
  input: FinalizeTurnInputV1,
): Promise<FinalizeTurnResultV1> {
  const began = deps.machine.apply("beginFinalization");
  if (began.kind === "illegal") {
    // DIAGNOSTIC (infrastructure/debug-log): finalize refused before anything was written -- no
    // commit, no page bytes, no chat record.
    trace("core.turns.finalize.outcome", {
      turnId: input.turnId,
      kind: "illegal",
      at: "beginFinalization",
      code: began.code,
    });
    return { kind: "illegal", code: began.code, at: "beginFinalization" };
  }

  const deadline = deps.deadlines.check();
  if (deadline.kind === "expired") {
    // DIAGNOSTIC (infrastructure/debug-log): finalize's own deadline re-check tripped after
    // beginFinalization succeeded but before any durable write was attempted.
    trace("core.turns.finalize.outcome", {
      turnId: input.turnId,
      kind: "failed",
      failure: deadlineExceededFailure(deadline.bound),
    });
    return { kind: "failed", failure: deadlineExceededFailure(deadline.bound) };
  }

  const readSet = toFinalizeReadSet(input.stagedReadSet);
  if (readSet instanceof Error) {
    // DIAGNOSTIC (infrastructure/debug-log): the staged read-set could not translate -- an internal
    // invariant violation, not an ordinary business rejection.
    trace("core.turns.finalize.outcome", {
      turnId: input.turnId,
      kind: "failed",
      failure: translationFailure(readSet.message),
    });
    return { kind: "failed", failure: translationFailure(readSet.message) };
  }

  const resolvedPins = resolveSentPinAppends({
    turnId: input.turnId,
    sentPins: input.sentPins,
    changedPages: input.changedPageSlugs,
    createdAt: input.createdAt,
  });

  const result = await wrap(
    deps.turnTransactions.finalize({
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      changedFiles: input.changedFiles,
      changedPageSlugs: input.changedPageSlugs,
      requestedActivePage: input.requestedActivePage,
      agentRecord: input.agentRecord,
      resolvedPins,
      readSet,
      createdAt: input.createdAt,
    }),
  );
  if ("code" in result) {
    // DIAGNOSTIC (infrastructure/debug-log): the durable transaction itself failed -- the turn
    // generated changes (agentRecord/changedPages) never landed.
    trace("core.turns.finalize.outcome", { turnId: input.turnId, kind: "failed", failure: result });
    return { kind: "failed", failure: result };
  }

  const committed = deps.machine.apply("markCommitted");
  if (committed.kind === "illegal") {
    // DIAGNOSTIC (infrastructure/debug-log): a durable commit exists (the call above already
    // returned it) but the turn machine could not settle onto it -- see this file's own header.
    trace("core.turns.finalize.outcome", {
      turnId: input.turnId,
      kind: "illegal",
      at: "markCommitted",
      code: committed.code,
    });
    return { kind: "illegal", code: committed.code, at: "markCommitted" };
  }

  const settled = deps.machine.apply("settle");
  if (settled.kind === "illegal") {
    // DIAGNOSTIC (infrastructure/debug-log): same durable-commit-exists concern as
    // markCommitted above -- markCommitted itself already landed, but settle could not.
    trace("core.turns.finalize.outcome", {
      turnId: input.turnId,
      kind: "illegal",
      at: "settle",
      code: settled.code,
    });
    return { kind: "illegal", code: settled.code, at: "settle" };
  }
  deps.onSettled?.();

  // The commit is durable now — see this file's header, "CANDIDATE RETIREMENT".
  await retireFinalizedCandidate(deps.staging, input.candidateRoot);

  // DIAGNOSTIC (infrastructure/debug-log): the turn's successful, durable commit, including the
  // agent-generated record text -- the record this whole generation pipeline exists to produce.
  trace("core.turns.finalize.outcome", {
    turnId: input.turnId,
    kind: "committed",
    commit: result,
    agentRecord: input.agentRecord,
  });
  return { kind: "committed", commit: result };
}

import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import { type SentPinV1, resolveSentPinAppends } from "core/pins/model/turn-resolution";
import type {
  ChangedPageOpV1,
  StagedTurnReadSetV1,
  TurnCommitV1,
  TurnTransactionService,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol";
import type { ChatAgentRecord } from "entities/chat";
import type { PageSlug } from "entities/page";

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
 */

export interface FinalizeTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly turnTransactions: TurnTransactionService;
  readonly deadlines: TurnDeadlines;
}

export interface FinalizeTurnInputV1 {
  readonly turnId: string;
  readonly targetChatId: string;
  /** Gate-validated diff; empty means no canonical page changed (§7.4 item 5). */
  readonly changedPages: readonly ChangedPageOpV1[];
  readonly validatedPageSlugs: readonly PageSlug[];
  readonly requestedActivePage?: PageSlug | null;
  readonly agentRecord: ChatAgentRecord;
  /** The turn's admission-time captured pin set (§12.2 item 1) — turn-resolution.ts's only pin source. */
  readonly sentPins: readonly SentPinV1[];
  readonly stagedReadSet: StagedTurnReadSetV1;
  readonly createdAt: string;
}

export type FinalizeTurnResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
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
  if (began.kind === "illegal") return { kind: "illegal", code: began.code };

  const deadline = deps.deadlines.check();
  if (deadline.kind === "expired")
    return { kind: "failed", failure: deadlineExceededFailure(deadline.bound) };

  const readSet = toFinalizeReadSet(input.stagedReadSet);
  if (readSet instanceof Error)
    return { kind: "failed", failure: translationFailure(readSet.message) };

  const resolvedPins = resolveSentPinAppends({
    turnId: input.turnId,
    sentPins: input.sentPins,
    changedPages: input.changedPages.map((op) => op.pageSlug),
    createdAt: input.createdAt,
  });

  const result = await wrap(
    deps.turnTransactions.finalize({
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      changedPages: input.changedPages,
      validatedPageSlugs: input.validatedPageSlugs,
      requestedActivePage: input.requestedActivePage,
      agentRecord: input.agentRecord,
      resolvedPins,
      readSet,
      createdAt: input.createdAt,
    }),
  );
  if ("code" in result) return { kind: "failed", failure: result };

  const committed = deps.machine.apply("markCommitted");
  if (committed.kind === "illegal") return { kind: "illegal", code: committed.code };

  const settled = deps.machine.apply("settle");
  if (settled.kind === "illegal") return { kind: "illegal", code: settled.code };

  return { kind: "committed", commit: result };
}

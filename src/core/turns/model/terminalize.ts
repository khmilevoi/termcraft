import { wrap } from "@reatom/core"

import type { StateMachine, TurnAction, TurnState, TurnTerminalOutcome } from "core/machines"
import type { TurnCommitV1, TurnTerminalRecordV1, TurnTransactionService } from "core/ports"
import type { CommandRejectionCode, FailureDtoV1 } from "core/protocol"
import { uuidv7 } from "infrastructure/uuid"

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
 */

export interface TerminalizeTurnDeps {
  readonly machine: StateMachine<TurnState, TurnAction>
  readonly turnTransactions: TurnTransactionService
}

export interface TerminalizeTurnInputV1 {
  readonly turnId: string
  readonly targetChatId: string
  readonly outcome: TurnTerminalOutcome
  readonly text: string
  /** Only meaningful for a `system:error` record (e.g. `"process_restart_before_intent"`). */
  readonly reason?: string
  readonly createdAt: string
}

export type TerminalizeTurnResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "recorded"; readonly commit: TurnCommitV1 }
  | { readonly kind: "unrecorded"; readonly failure: FailureDtoV1 }

/**
 * §7.2 verbatim: "`failed` persists as a `system:error` record with typed outcome
 * `error`; `cancelled` persists as `system:cancelled`; `stale` and `interrupted` persist
 * as `system:error` records with the same-named outcomes." `turnId` is always set,
 * `actionId` always absent — this is a TURN terminalization, never a standalone action.
 */
function buildTerminalRecord(input: TerminalizeTurnInputV1): TurnTerminalRecordV1 {
  const recordId = uuidv7()

  if (input.outcome === "cancelled") {
    return { kind: "system:cancelled", recordId, turnId: input.turnId, text: input.text, ts: input.createdAt }
  }

  // "failed" is the one outcome whose record-level name DIFFERS from the outcome name
  // (§7.2: "typed outcome `error`", not "failed") — "stale"/"interrupted" pass through
  // under their own name.
  const outcome: "error" | "stale" | "interrupted" = input.outcome === "failed" ? "error" : input.outcome
  return {
    kind: "system:error",
    recordId,
    turnId: input.turnId,
    outcome,
    reason: input.reason,
    text: input.text,
    ts: input.createdAt,
  }
}

export async function terminalizeTurn(deps: TerminalizeTurnDeps, input: TerminalizeTurnInputV1): Promise<TerminalizeTurnResultV1> {
  const finished = deps.machine.apply("finishTerminalization")
  if (finished.kind === "illegal") return { kind: "illegal", code: finished.code }

  const record = buildTerminalRecord(input)
  const result = await wrap(
    deps.turnTransactions.terminalize({
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      record,
      createdAt: input.createdAt,
    }),
  )

  // Unconditional: §7.2 allows this edge on EITHER a recorded outcome or a typed
  // unrecorded condition — see this file's header.
  deps.machine.apply("settle")

  if ("code" in result) return { kind: "unrecorded", failure: result }
  return { kind: "recorded", commit: result }
}

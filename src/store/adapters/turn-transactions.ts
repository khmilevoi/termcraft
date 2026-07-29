import type {
  AssertConforms,
  TurnAdmissionInputV1,
  TurnCommitV1,
  TurnFinalizeInputV1,
  TurnTerminalizeInputV1,
  TurnTransactionService,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { CommittedMarker } from "store/transaction";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";

// `createTurnTransactionsAdapter` — the `TurnTransactionService` port over
// `OpenProject.transactions`'s `admitTurn`/`finalizeTurn`/`terminalizeTurn` (plan Task 2).
//
// `TurnReadSetV1`/`ChangedDesignFileOpV1`/`ResolvedPinAppendV1`/`TurnTerminalRecordV1` are
// structurally IDENTICAL to store's `TurnReadSet`/`ChangedDesignFileOp`/`ResolvedPinAppend`/
// `TurnTerminalRecord` (the latter two reuse `entities/pin`/`entities/chat` verbatim on both
// sides), so they pass straight through with no field-by-field mapping.
//
// GAP CLOSED (plan Task 7): store's `TurnFinalizeInput` no longer carries `manifestBefore`
// (plan Task 5 — `project.toml` carries no page order, so finalization never derives a
// manifest write from one; the engine's own CAS re-check inside `finalizeTurn` re-observes
// `readSet.manifest` instead). This adapter therefore no longer reads the manifest before
// calling `finalizeTurn` either — `input.readSet`/`input.changedFiles`/`input.changedPageSlugs`
// pass straight through.
//
// CAS mapping: a `finalize()` failure that is `SourceChangedError`/`StaleError` is mapped by
// `toFailureDto` onto `APPLY_SOURCE_CHANGED`/`APPLY_STALE` with the correct `details.part` —
// no separate mapping needed here.

function toCommitV1(committed: CommittedMarker): TurnCommitV1 {
  return { transactionId: committed.transactionId };
}

export function createTurnTransactionsAdapter(deps: StoreAdapterDeps): TurnTransactionService {
  const { open } = deps;

  async function admit(input: TurnAdmissionInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    const result = await open.transactions.admitTurn({
      transactionId: deps.uuidv7(),
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      userRecord: input.userRecord,
      createdAt: input.createdAt,
    });
    if (result instanceof Error) return toFailureDto(result);
    return toCommitV1(result);
  }

  async function finalize(input: TurnFinalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    const result = await open.transactions.finalizeTurn({
      transactionId: deps.uuidv7(),
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      changedFiles: input.changedFiles,
      changedPageSlugs: input.changedPageSlugs,
      requestedActivePage: input.requestedActivePage,
      agentRecord: input.agentRecord,
      resolvedPins: input.resolvedPins,
      readSet: input.readSet,
      createdAt: input.createdAt,
    });
    if (result instanceof Error) return toFailureDto(result);
    return toCommitV1(result);
  }

  async function terminalize(input: TurnTerminalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    const result = await open.transactions.terminalizeTurn({
      transactionId: deps.uuidv7(),
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      record: input.record,
      createdAt: input.createdAt,
    });
    if (result instanceof Error) return toFailureDto(result);
    return toCommitV1(result);
  }

  return { admit, finalize, terminalize };
}

type _Conforms = AssertConforms<
  TurnTransactionService,
  ReturnType<typeof createTurnTransactionsAdapter>
>;

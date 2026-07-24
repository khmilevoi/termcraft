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
// `TurnReadSetV1`/`ChangedPageOpV1`/`ResolvedPinAppendV1`/`TurnTerminalRecordV1` are
// structurally IDENTICAL to store's `TurnReadSet`/`ChangedPageOp`/`ResolvedPinAppend`/
// `TurnTerminalRecord` (the latter two reuse `entities/pin`/`entities/chat` verbatim on both
// sides), so they pass straight through with no field-by-field mapping.
//
// RESOLVED GAP (honest adapter-level composition): store's `TurnFinalizeInput` additionally
// requires `manifestBefore: ProjectManifest` — the portable manifest AS OBSERVED AT THE START
// of finalization — which `TurnFinalizeInputV1` never carries (it is not a per-call fact the
// port needs to expose; the engine's own CAS re-check inside `finalizeTurn` re-observes the
// manifest anyway). This adapter reads it via `open.manifest.read()` immediately before
// calling `finalizeTurn`, mirroring the identical pattern `page-store.ts`'s `reorder`/`remove`
// already use for the same store input field.
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
    const manifestBefore = await open.manifest.read();
    if (manifestBefore instanceof Error) return toFailureDto(manifestBefore);

    const result = await open.transactions.finalizeTurn({
      transactionId: deps.uuidv7(),
      turnId: input.turnId,
      targetChatId: input.targetChatId,
      changedPages: input.changedPages,
      validatedPageSlugs: input.validatedPageSlugs,
      manifestBefore,
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

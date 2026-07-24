import type {
  AssertConforms,
  OrphanTurnOutcomeV1,
  RecoveryOutcomeV1,
  RecoveryService,
  TransactionClassificationV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type { TransactionClassification } from "store/transaction";
import { classifyTransaction, nodeTransactionFsDeps, readIntent } from "store/transaction";

import type { OpenProject } from "../types";
import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";

// `createRecoveryAdapter` — the `RecoveryService` port over `OpenProject.recovery`/
// `orphanTurns` (the ALREADY-RUN startup passes) plus `store/transaction`'s
// `classifyTransaction`/`readIntent` for the two per-transaction diagnostic reads (plan
// Task 3).
//
// `recover()`/`scanOrphanTurns()` return the passes `openProject`/`createProject` already
// performed once before this project handle existed (`store/types.ts`'s own doc: "run once
// before Workspace opens") — this port's own doc agrees ("The complete startup recovery
// pass, run once before Workspace opens"), so these surface `open.recovery`/`open.orphanTurns`
// rather than re-running `TransactionEngine.recover()`/a fresh multi-chat scan a second time.
//
// `classify`/`hasIntentRecord` need no new store-internal accessor: `nodeTransactionFsDeps`
// (built fresh from `open.safeFs`) plus `store/transaction`'s already-public
// `classifyTransaction`/`readIntent` are exactly the pure, read-only primitives
// `recoverTransactions` itself is built from.

function toRecoveryOutcomeV1(outcome: OpenProject["recovery"]): RecoveryOutcomeV1 {
  if (outcome.ok) return outcome;
  return { ok: false, transactionId: outcome.transactionId, error: toFailureDto(outcome.error) };
}

function toClassificationV1(
  classification: TransactionClassification,
): TransactionClassificationV1 {
  if (classification.kind === "conflict") {
    return {
      kind: "conflict",
      transactionId: classification.transactionId,
      reason: classification.conflict.reason,
    };
  }
  return { kind: classification.kind, transactionId: classification.transactionId };
}

export function createRecoveryAdapter(deps: StoreAdapterDeps): RecoveryService {
  const { open } = deps;
  const fsDeps = nodeTransactionFsDeps(open.safeFs);

  async function recover(): Promise<RecoveryOutcomeV1> {
    return toRecoveryOutcomeV1(open.recovery);
  }

  async function classify(
    transactionId: string,
  ): Promise<FailureDtoV1 | TransactionClassificationV1> {
    const result = classifyTransaction(fsDeps, transactionId);
    if (result instanceof Error) return toFailureDto(result);
    return toClassificationV1(result);
  }

  async function hasIntentRecord(transactionId: string): Promise<FailureDtoV1 | boolean> {
    const result = readIntent(fsDeps, transactionId);
    if (result instanceof Error) return toFailureDto(result);
    return result !== null;
  }

  async function scanOrphanTurns(): Promise<FailureDtoV1 | readonly OrphanTurnOutcomeV1[]> {
    return open.orphanTurns;
  }

  return { recover, classify, hasIntentRecord, scanOrphanTurns };
}

type _Conforms = AssertConforms<RecoveryService, ReturnType<typeof createRecoveryAdapter>>;

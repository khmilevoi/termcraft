import type { FailureDtoV1 } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  OrphanTurnOutcomeV1,
  RecoveryOutcomeV1,
  RecoveryService,
  TransactionClassificationV1,
} from "../recovery";

/**
 * In-memory {@link RecoveryService} fake (6D task brief). `recover()`'s failure shape is
 * its OWN `RecoveryOutcomeV1` union, not `FailureDtoV1` — so it gets its own one-shot
 * `scriptRecoverOutcome` queue rather than `failNext`, matching the port's own return type
 * instead of forcing every method onto one vocabulary. `classify`/`hasIntentRecord`/
 * `scanOrphanTurns` DO return `FailureDtoV1` and get the ring's usual `failNext`.
 */

const DEFAULT_RECOVER_OUTCOME: RecoveryOutcomeV1 = {
  ok: true,
  recovered: 0,
  discarded: 0,
  alreadyComplete: 0,
};

export type RecoveryFailableMethod = "classify" | "hasIntentRecord" | "scanOrphanTurns";

export type RecoveryCall =
  | { readonly method: "recover" }
  | { readonly method: "classify"; readonly transactionId: string }
  | { readonly method: "hasIntentRecord"; readonly transactionId: string }
  | { readonly method: "scanOrphanTurns" };

export interface FakeRecoveryService extends RecoveryService {
  readonly calls: readonly RecoveryCall[];
  failNext(method: RecoveryFailableMethod, failure: FailureDtoV1): void;
  /** Queues the next `recover()` outcome (FIFO), one shot; default when empty is a clean, empty pass. */
  scriptRecoverOutcome(outcome: RecoveryOutcomeV1): void;
  /** Test-only seam for proving the `failBeforeIntent` edge (6C's transition table). */
  setIntentRecord(transactionId: string, present: boolean): void;
}

export function createFakeRecoveryService(options?: {
  readonly classifications?: ReadonlyMap<string, TransactionClassificationV1>;
  readonly orphans?: readonly OrphanTurnOutcomeV1[];
}): FakeRecoveryService {
  const calls: RecoveryCall[] = [];
  const recoverOutcomes: RecoveryOutcomeV1[] = [];
  const intentRecords = new Set<string>();
  const classifications = new Map(options?.classifications ?? []);
  const orphans = [...(options?.orphans ?? [])];

  const queues: Record<RecoveryFailableMethod, FailureDtoV1[]> = {
    classify: [],
    hasIntentRecord: [],
    scanOrphanTurns: [],
  };

  function failNext(method: RecoveryFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  function scriptRecoverOutcome(outcome: RecoveryOutcomeV1): void {
    recoverOutcomes.push(outcome);
  }

  function setIntentRecord(transactionId: string, present: boolean): void {
    if (present) intentRecords.add(transactionId);
    else intentRecords.delete(transactionId);
  }

  async function recover(): Promise<RecoveryOutcomeV1> {
    calls.push({ method: "recover" });
    return recoverOutcomes.shift() ?? DEFAULT_RECOVER_OUTCOME;
  }

  async function classify(
    transactionId: string,
  ): Promise<FailureDtoV1 | TransactionClassificationV1> {
    calls.push({ method: "classify", transactionId });
    const queued = queues.classify.shift();
    if (queued !== undefined) return queued;
    return classifications.get(transactionId) ?? { kind: "complete", transactionId };
  }

  async function hasIntentRecord(transactionId: string): Promise<FailureDtoV1 | boolean> {
    calls.push({ method: "hasIntentRecord", transactionId });
    const queued = queues.hasIntentRecord.shift();
    if (queued !== undefined) return queued;
    return intentRecords.has(transactionId);
  }

  async function scanOrphanTurns(): Promise<FailureDtoV1 | readonly OrphanTurnOutcomeV1[]> {
    calls.push({ method: "scanOrphanTurns" });
    const queued = queues.scanOrphanTurns.shift();
    if (queued !== undefined) return queued;
    return [...orphans];
  }

  return {
    recover,
    classify,
    hasIntentRecord,
    scanOrphanTurns,
    calls,
    failNext,
    scriptRecoverOutcome,
    setIntentRecord,
  };
}

type _Conforms = AssertConforms<RecoveryService, FakeRecoveryService>;

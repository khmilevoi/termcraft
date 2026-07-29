import type { FailureDtoV1 } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  ResolvedPinAppendV1,
  TurnAdmissionInputV1,
  TurnCommitV1,
  TurnFinalizeInputV1,
  TurnTerminalizeInputV1,
  TurnTransactionService,
} from "../turn-transactions";

/**
 * In-memory {@link TurnTransactionService} fake (6D task brief). No real CAS/read-set
 * comparison is implemented — a test that needs `APPLY_SOURCE_CHANGED`/`APPLY_STALE`
 * SCRIPTS that exact failure via `failNext("finalize", …)` rather than the fake deriving
 * it from hash math, matching this ring's "programmable failure" design (the fake is
 * dumb and scriptable, not a re-implementation of `store/transaction`'s engine).
 *
 * `finalize()` DOES apply the one filtering rule turn-durability §7.4 item 5 fixes and
 * this port's own doc restates — "filtered internally to pages whose closure changed... an
 * empty diff resolves no pin" — because that filter is the exact behavior 6F's tests need to
 * observe happening, not a policy a test should have to script per call. The filter is by
 * `changedPageSlugs` (the caller's closure diff), gated on `changedFiles` being non-empty at
 * all — mirroring `store/transaction/model/wrappers.ts`'s `finalizeTurn` verbatim.
 */

export type TurnTransactionFailableMethod = "admit" | "finalize" | "terminalize";

export type TurnTransactionCall =
  | { readonly method: "admit"; readonly input: TurnAdmissionInputV1 }
  | {
      readonly method: "finalize";
      readonly input: TurnFinalizeInputV1;
      readonly appliedResolvedPins: readonly ResolvedPinAppendV1[];
    }
  | { readonly method: "terminalize"; readonly input: TurnTerminalizeInputV1 };

export interface FakeTurnTransactionService extends TurnTransactionService {
  readonly calls: readonly TurnTransactionCall[];
  failNext(method: TurnTransactionFailableMethod, failure: FailureDtoV1): void;
}

export function createFakeTurnTransactionService(): FakeTurnTransactionService {
  const calls: TurnTransactionCall[] = [];
  let counter = 0;

  const queues: Record<TurnTransactionFailableMethod, FailureDtoV1[]> = {
    admit: [],
    finalize: [],
    terminalize: [],
  };

  function failNext(method: TurnTransactionFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  function mintCommit(): TurnCommitV1 {
    counter += 1;
    return { transactionId: `fake-transaction-${counter}` };
  }

  async function admit(input: TurnAdmissionInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    calls.push({ method: "admit", input });
    const queued = queues.admit.shift();
    if (queued !== undefined) return queued;
    return mintCommit();
  }

  async function finalize(input: TurnFinalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    const changedSlugs = new Set(input.changedPageSlugs);
    const appliedResolvedPins =
      input.changedFiles.length === 0
        ? []
        : input.resolvedPins.filter((resolved) => changedSlugs.has(resolved.pageSlug));
    calls.push({ method: "finalize", input, appliedResolvedPins });
    const queued = queues.finalize.shift();
    if (queued !== undefined) return queued;
    return mintCommit();
  }

  async function terminalize(input: TurnTerminalizeInputV1): Promise<FailureDtoV1 | TurnCommitV1> {
    calls.push({ method: "terminalize", input });
    const queued = queues.terminalize.shift();
    if (queued !== undefined) return queued;
    return mintCommit();
  }

  return { admit, finalize, terminalize, calls, failNext };
}

type _Conforms = AssertConforms<TurnTransactionService, FakeTurnTransactionService>;

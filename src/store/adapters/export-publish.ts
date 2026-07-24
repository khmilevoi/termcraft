import * as errore from "errore";

import type {
  AssertConforms,
  ExportPublicationV1,
  ExportPublishOperationV1,
  ExportPublishPlanV1,
  ExportPublishPort,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import type {
  FileImage,
  ProjectWritePermit,
  TransactionFsDeps,
  TransactionOperation,
  TransactionWrapperDeps,
} from "store/transaction";
import {
  buildExportPublishTransaction,
  nodeTransactionFsDeps,
  observeFileImage,
} from "store/transaction";

import type { StoreAdapterDeps } from "./types";

// `createExportPublishAdapter` — the `ExportPublishPort` port over `store/transaction`'s
// `buildExportPublishTransaction` (plan Task 4, "Design Q1").
//
// DESIGN Q1 — THE PERMIT CHANNEL (resolved, recorded here per the plan's Step 0): the port
// header's claim that the real adapter "reacquires internally" the `WriteMutex` cannot hold
// for the landed engine — `publishExport` (`core/export/model/publish.ts`) already acquires
// the SAME mutex and holds it across this very call (kernel-command-contract §12.5's
// revalidate-then-intent atomicity), so a second `acquire()` here would FIFO-block behind
// itself. The genuinely missing channel is the LIVE PERMIT, not the source read-set (the
// WP-1 reviewer's hedge) — `publish(plan)` carries neither. `store/transaction`'s `WriteMutex`
// had no "current holder" accessor (verified by reading `write-mutex.ts` in full), so this
// task adds one: `WriteMutex.currentPermit()` (this same commit's companion change,
// `store/transaction/model/write-mutex.ts`) — an in-module, store-internal addition (no
// `core/ports` signature change, no second mutex) rather than the plan's documented
// maintainer-approved-additive-V1 fallback. This adapter, constructed over the SAME
// `OpenProject.writeMutex` `project-write.ts`'s adapter exposes, calls `currentPermit()` to
// get the permit `publishExport` is already holding and passes it straight into
// `buildExportPublishTransaction` — never releasing and reacquiring.
//
// `plan.operations`/`plan.payloads` are empty until WP-5 (`export/model/publish.ts:167-177`),
// so the precondition built from `plan.operations[].oldImage` is trivially satisfiable today —
// this adapter is a correct, thin pass-through, not yet load-bearing.

/** `export.retry`'s own "the export-output snapshot drifted" case (turn-durability §10 step 3's re-CAS, NOT the source read-set — see Design Q1 above). */
export class ExportSnapshotStaleError extends errore.createTaggedError({
  name: "ExportSnapshotStaleError",
  message: "export target $target no longer matches its expected pre-publish image",
}) {}

function imagesEqual(a: FileImage, b: FileImage): boolean {
  if (a.state === "absent" && b.state === "absent") return true;
  if (a.state === "file" && b.state === "file") return a.sha256 === b.sha256 && a.size === b.size;
  return false;
}

/** turn-durability §10 step 3: re-CAS every export-output target against its planned old image, immediately before intent. */
function buildPrecondition(
  fs: TransactionFsDeps,
  operations: readonly ExportPublishOperationV1[],
): () => Error | null {
  return () => {
    for (const op of operations) {
      const current = observeFileImage(fs, op.target);
      if (current instanceof Error) return current;
      if (!imagesEqual(current, op.oldImage))
        return new ExportSnapshotStaleError({ target: op.target });
    }
    return null;
  };
}

function toStoreOperation(op: ExportPublishOperationV1): TransactionOperation {
  return {
    index: op.index,
    target: op.target,
    mode: op.mode,
    oldImage: op.oldImage,
    newImage: op.newImage,
    payloadId: op.payloadId,
  };
}

/**
 * The plan's own two export codes (not the shared `toFailureDto`'s per-store-class table —
 * this whole call is scoped to ONE export publication attempt, so every non-precondition
 * failure collapses to `EXPORT_PUBLICATION_FAILED` rather than the generic classification an
 * unrelated adapter's identical underlying fault would get).
 */
function toExportFailureDto(error: Error): FailureDtoV1 {
  if (error instanceof ExportSnapshotStaleError) {
    return {
      code: "EXPORT_SNAPSHOT_STALE",
      retryable: false,
      safeMessage: error.message,
      details: {},
    };
  }
  return {
    code: "EXPORT_PUBLICATION_FAILED",
    retryable: false,
    safeMessage: error.message,
    details: {},
  };
}

function noActivePermitFailure(): FailureDtoV1 {
  console.warn(
    "store/adapters/export-publish: publish() called with no active write-mutex permit — the caller must hold one across the whole revalidate-then-publish window (kernel-command-contract §12.5)",
  );
  return {
    code: "EXPORT_PUBLICATION_FAILED",
    retryable: false,
    safeMessage: "no active project-write permit was held at publish time",
    details: {},
  };
}

export function createExportPublishAdapter(deps: StoreAdapterDeps): ExportPublishPort {
  const { open } = deps;
  const fs = nodeTransactionFsDeps(open.safeFs);
  const wrapperDeps: TransactionWrapperDeps = { fs, append: { newPayloadId: deps.uuidv7 } };

  async function publish(plan: ExportPublishPlanV1): Promise<FailureDtoV1 | ExportPublicationV1> {
    const permit: ProjectWritePermit | null = open.writeMutex.currentPermit();
    if (permit === null) return noActivePermitFailure();

    const operations = plan.operations.map(toStoreOperation);
    const result = await buildExportPublishTransaction(wrapperDeps, {
      mutex: open.writeMutex,
      permit,
      transactionId: deps.uuidv7(),
      generationId: plan.generationId,
      operations,
      payloads: plan.payloads,
      createdAt: plan.createdAt,
      precondition: buildPrecondition(fs, plan.operations),
    });
    if (result instanceof Error) return toExportFailureDto(result);

    return {
      transactionId: result.transactionId,
      generationId: plan.generationId,
      pageCount: plan.pageCount,
      recordedAt: plan.createdAt,
    };
  }

  return { publish };
}

type _Conforms = AssertConforms<ExportPublishPort, ReturnType<typeof createExportPublishAdapter>>;

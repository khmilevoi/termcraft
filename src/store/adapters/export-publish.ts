import * as errore from "errore";

import {
  type AssertConforms,
  EXPORT_POINTER_TARGET,
  type ExportPointerV1,
  type ExportPublicationV1,
  type ExportPublishOperationV1,
  type ExportPublishPlanV1,
  type ExportPublishPort,
  exportPointerV1Schema,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import { FsAccessError, isNotFound } from "store/safe-fs";
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

import { toFailureDto } from "./failure";
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

/**
 * `readPointer()`'s own failure (WP-5 Phase C task C2): the pointer at `$target` is
 * unreadable as JSON, fails {@link exportPointerV1Schema}, or references a generation
 * directory that does not exist (D-Q4's shallow structural check). Maps to
 * `PERSISTENCE_FAILED` in {@link toExportFailureDto} — the same "durable data this ring
 * read back is internally inconsistent" mapping `store/adapters/failure.ts`'s shared
 * `toFailureDto` already uses for `ManifestCorruptError`/`JournalCorruptError`, not a new
 * §11.2 code invented for this one path.
 */
export class ExportPointerCorruptError extends errore.createTaggedError({
  name: "ExportPointerCorruptError",
  message: "export pointer $target is corrupt: $reason",
}) {}

/** `export/generations/<generationId>` — the managed directory a valid pointer must reference (D-Q4). */
function exportGenerationDir(generationId: string): string {
  return `export/generations/${generationId}`;
}

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
  if (error instanceof ExportPointerCorruptError) {
    return {
      code: "PERSISTENCE_FAILED",
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

  async function readPointer(): Promise<FailureDtoV1 | ExportPointerV1 | null> {
    const bytes = open.safeFs.readFile(EXPORT_POINTER_TARGET);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) return null;
      return toFailureDto(bytes);
    }

    const parsed = errore.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      catch: (cause) =>
        new ExportPointerCorruptError({
          target: EXPORT_POINTER_TARGET,
          reason: "not valid JSON",
          cause,
        }),
    });
    if (parsed instanceof Error) return toExportFailureDto(parsed);

    const validated = exportPointerV1Schema.safeParse(parsed);
    if (!validated.success) {
      return toExportFailureDto(
        new ExportPointerCorruptError({
          target: EXPORT_POINTER_TARGET,
          reason: validated.error.issues[0]?.message ?? "failed schema validation",
          cause: validated.error,
        }),
      );
    }

    // D-Q4: confirm the referenced generation directory exists — never a full re-hash of
    // every file the manifest lists.
    const generationDir = exportGenerationDir(validated.data.generationId);
    const listing = open.safeFs.list(generationDir);
    if (listing instanceof Error) {
      return toExportFailureDto(
        new ExportPointerCorruptError({
          target: EXPORT_POINTER_TARGET,
          reason: `referenced generation directory "${generationDir}" does not exist or is inaccessible`,
          cause: listing,
        }),
      );
    }

    return validated.data;
  }

  return { publish, readPointer };
}

type _Conforms = AssertConforms<ExportPublishPort, ReturnType<typeof createExportPublishAdapter>>;

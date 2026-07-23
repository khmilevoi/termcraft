import type { FailureDtoV1 } from "core/protocol";

import type { FileImageV1 } from "./turn-transactions";

/**
 * `ExportPublishPort`: turn-durability §10 steps 4-6's `ExportPublishTransaction` — create
 * every new-generation file, replace the `export/current.json` pointer, then delete the
 * old generation's files, all inside one durable transaction — narrowed from `store/
 * transaction`'s real `buildExportPublishTransaction` (`store/transaction/model/
 * wrappers.ts:1066`) per decision C1: every shape below is a core-owned redraw over
 * `entities/` + local DTOs, never an import of `store/transaction`'s own
 * `ExportPublishInput`/`TransactionOperation`/`RunTransactionInput` types themselves.
 *
 * `export/model/publish.ts`'s `publishExport` already performs the ONE core-side re-CAS
 * (§12.5: settings/identity match + live source-hash re-read) before it ever reaches this
 * port — that is a DOMAIN check `core` owns with its existing `PageReader`/
 * `ProjectWriteCoordinator` ports. `buildExportPublishTransaction`'s own `precondition` is a
 * SEPARATE, lower-level re-check the store engine runs right before `intent.json` becomes
 * durable (§4.3 step 3) — it needs live `SafeFs` access `core` never holds, so it is NOT
 * redrawn here; the real adapter (WP-2) builds that closure from its own store-side state,
 * the same way `TurnTransactionService`'s adapter owns its mutex/permit internally
 * (`turn-transactions.ts`'s header note) without either crossing this port as data.
 *
 * MUTEX/PERMIT ARE ABSENT FROM `ExportPublishPlanV1` for the identical reason
 * `turn-transactions.ts` documents: the real adapter already holds the SAME `WriteMutex`
 * instance `ProjectWriteCoordinator` (`project-write.ts`) exposes, reacquired internally —
 * never a second one (blocker B2).
 *
 * `transactionId` IS ABSENT FROM THE PLAN, matching `TurnTransactionService`'s own pattern
 * (`TurnAdmissionInputV1` etc. never carry one either): the adapter mints it when it calls
 * `buildExportPublishTransaction`, and only the confirmed {@link ExportPublicationV1} echoes
 * it back, as an opaque id for tracing/diagnostics, never a value the caller branches on.
 */

/**
 * Mirrors `store/transaction`'s `TransactionOperationMode`, narrowed to the two modes
 * turn-durability §10 step 4 actually uses for export publication — create-new generation
 * files and the `current.json` pointer are always `"replace"`, the formerly-referenced
 * generation's files are always `"delete"` — an export-publish transaction never appends.
 */
export type ExportPublishOperationModeV1 = "replace" | "delete";

/**
 * One planned filesystem change, redrawn from `store/transaction`'s `TransactionOperation`
 * per decision C1 (reusing {@link FileImageV1} from `turn-transactions.ts` rather than a
 * second copy of the same mirrored shape).
 */
export interface ExportPublishOperationV1 {
  readonly index: number;
  /** Normalized path relative to `.termcraft` (turn-durability §3.3), e.g. `export/current.json`. */
  readonly target: string;
  readonly mode: ExportPublishOperationModeV1;
  readonly oldImage: FileImageV1;
  readonly newImage: FileImageV1;
  /** Required when `mode === "replace"` — the payload key into `plan.payloads`. */
  readonly payloadId?: string;
}

/**
 * What `buildExportPublishTransaction` needs to run the publish transaction, redrawn per
 * decision C1. `generationId`/`pageCount`/`createdAt` are exactly the facts `publishExport`
 * already computes as `ExportPublicationIntentV1` (`export/model/publish.ts`) — this plan is
 * that same fact plus the raw file operations/payloads the transaction actually executes.
 */
export interface ExportPublishPlanV1 {
  readonly generationId: string;
  readonly pageCount: number;
  /** RFC 3339 UTC — the injected clock's read at plan-build time (mirrors `ExportPublishInput.createdAt`). */
  readonly createdAt: string;
  /** Caller-ordered (§10 step 4): every new generation file, then the `current.json` pointer, then old-generation deletes. */
  readonly operations: readonly ExportPublishOperationV1[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/**
 * The durably committed publication receipt — echoes `ExportPublicationIntentV1`'s own
 * fields (`export/model/publish.ts`) now that they are actually on disk, plus the store
 * transaction's own id for tracing.
 */
export interface ExportPublicationV1 {
  readonly transactionId: string;
  readonly generationId: string;
  readonly pageCount: number;
  readonly recordedAt: string;
}

export interface ExportPublishPort {
  /** Runs the export-publish transaction (turn-durability §10 steps 4-6) to completion. */
  publish(plan: ExportPublishPlanV1): Promise<FailureDtoV1 | ExportPublicationV1>;
}

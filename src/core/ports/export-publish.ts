import { z } from "zod";

import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import { sha256HexSchema } from "core/protocol";

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
 *
 * READ SIDE (WP-5 Phase C, task C1): {@link ExportPublishPort.readPointer} plus
 * {@link ExportPointerV1}/{@link exportPointerV1Schema} close the M6 gap
 * `core/project/model/open-sequence.ts`'s header used to flag — "no port exposes
 * `.termcraft/export/current.json`". D-Q2 fixes this port method's return shape as the
 * SAME schema the write side (Phase B) serializes, so a reader and a writer built in
 * parallel cannot silently diverge on the pointer's shape.
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

/**
 * Managed path (relative to `.termcraft`, turn-durability §3.3) of the durable export
 * pointer — the literal every {@link ExportPublishOperationV1.target} for the pointer
 * file itself uses, matching the fixture convention already established at
 * `store/model/launch.test.ts:1186`.
 */
export const EXPORT_POINTER_TARGET = "export/current.json";

/** One file's manifest entry inside an {@link ExportPointerV1} (turn-durability §12 :964-966's "a SHA-256 manifest of every file in the generation"). */
export interface ExportPointerFileV1 {
  readonly sha256: Sha256Hex;
  readonly size: number;
}

/**
 * The durable `export/current.json` contents (D-Q2, turn-durability §12 :964-966
 * verbatim): a schema version, the generation it points at, and a SHA-256 manifest of
 * every file that generation holds — keyed by the file's managed-relative path (the same
 * convention {@link ExportPublishOperationV1.target} uses). Both the write side
 * (`core/export/model/publish-plan.ts`, Phase B) and the read side
 * ({@link ExportPublishPort.readPointer}) decode/encode through the SAME
 * {@link exportPointerV1Schema} so the two sides, built in parallel, cannot silently
 * disagree about the shape.
 */
export interface ExportPointerV1 {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly files: Readonly<Record<string, ExportPointerFileV1>>;
}

const exportPointerFileV1Schema = z.strictObject({
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative(),
});

/** D-Q2's shared decode/encode target for {@link ExportPointerV1} — the one place `export/current.json` bytes are parsed or serialized, on both the write side and this read side. */
export const exportPointerV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  generationId: z.string().min(1),
  files: z.record(z.string().min(1), exportPointerFileV1Schema),
});

export interface ExportPublishPort {
  /** Runs the export-publish transaction (turn-durability §10 steps 4-6) to completion. */
  publish(plan: ExportPublishPlanV1): Promise<FailureDtoV1 | ExportPublicationV1>;

  /**
   * Reads and validates the durable export pointer, {@link EXPORT_POINTER_TARGET}
   * (turn-durability §12 step 9: "...export pointer..."). `null` means the project has
   * never published an export — ABSENT IS VALID, never a failure (a fresh project has no
   * `export/current.json`; `store/adapters/export-publish.test.ts` proves this). A
   * `FailureDtoV1` reports an unparseable/schema-invalid pointer, or one whose referenced
   * generation directory does not exist. Depth is intentionally shallow (D-Q4): a
   * structural parse plus confirming the referenced generation directory exists — never a
   * full re-hash of every file the manifest lists, a cost TD §12 step 9 does not ask a
   * fresh project open to pay.
   */
  readPointer(): Promise<FailureDtoV1 | ExportPointerV1 | null>;
}

/**
 * `core/export`'s public entry point (CLAUDE.md "Code style": every module gets a root
 * `types.ts` and `index.ts`) — the Export model's four phases (kernel-command-contract
 * §7.5, §12.5): the size ladder, the short-permit snapshot, the bounded render dispatch,
 * package assembly, and the reacquire-revalidate-publish transaction.
 */

// --- Shared vocabulary -------------------------------------------------------------------
export type { ExportPageInputV1, ExportPageSnapshotV1, ExportSnapshotV1 } from "./types";

// --- Size ladder --------------------------------------------------------------------------
export type { SizeLadderEntryV1, SizeLadderPageInputV1 } from "./model/size-ladder";
export {
  STANDARD_EXPORT_SIZES,
  computeExportSizeLadder,
  computePageSizeLadder,
} from "./model/size-ladder";

// --- The short-permit snapshot (idle -> preparing -> rendering) ---------------------------
export type {
  CaptureExportSnapshotDeps,
  CaptureExportSnapshotInputV1,
  CaptureExportSnapshotResultV1,
} from "./model/snapshot";
export { captureExportSnapshot } from "./model/snapshot";

// --- Bounded render dispatch (rendering) ---------------------------------------------------
export type { ExportRenderJobDeps, ExportRenderJobResultV1 } from "./model/render-jobs";
export { buildExportRenderKey, runExportRendering } from "./model/render-jobs";

// --- Package assembly -----------------------------------------------------------------------
export type {
  AssembleExportPackageInputV1,
  AssembleExportPackageResultV1,
  ExportPackageFileV1,
} from "./model/package";
export { assembleExportPackage } from "./model/package";

// --- Publish-plan builder (D-Q2/D-Q5) -------------------------------------------------------
export type {
  BuildExportPublishOperationsInputV1,
  BuildExportPublishOperationsResultV1,
} from "./model/publish-plan";
export { buildExportPublishOperations, serializeExportPointer } from "./model/publish-plan";

// --- Publication (rendering -> publishing -> idle) -------------------------------------------
export type {
  ExportPublicationIntentV1,
  PublishExportDeps,
  PublishExportInputV1,
  PublishExportRenderOutcomeV1,
  PublishExportResultV1,
} from "./model/publish";
export { publishExport } from "./model/publish";

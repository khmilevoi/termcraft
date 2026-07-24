import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { PageSlug } from "entities/page";

import type { ReadSetFileSnapshotV1 } from "./staging";

/**
 * The open-project facade `core` needs at startup (turn-durability §12 / storage-identity
 * §14.1): lease identity, the portable manifest, and the machine-local workspace state.
 * Everything else `store/index.ts`'s real `OpenProject` bundles — chats, pages, pins,
 * transactions, trust, projections, staging, backups, migrations — gets its OWN narrow
 * port elsewhere in this ring (code-structure §5: "two consumers in different modules
 * mean two narrow ports" generalizes to "two DIFFERENT concerns in the same module mean
 * two narrow ports" here); folding all nine into one `ProjectStore` would recreate the
 * "shared contracts pile" §11 forbids.
 *
 * DAG note (decision C1): `store/index.ts`'s real `OpenProject`/`ManifestStore`/
 * `WorkspaceStateStore` types are NOT imported here — `core` imports no other module — so
 * every shape below is a narrow, core-owned redraw of the same facts, not the store type
 * itself. `store`'s tagged errors (`SafeFsError`, `ManifestCorruptError`,
 * `ManifestTooNewError`, …) map to `FailureDtoV1` at the adapter boundary the composition
 * root wires in phase 8; this port never names a store error class.
 *
 * `ReadSetFileSnapshotV1` is reused verbatim from `./staging` (the same cross-port-file
 * import precedent `chat-store.ts`'s own `readAppendBase` and `export-publish.ts`'s
 * `FileImageV1` import already establish) rather than a second, structurally-identical
 * `{sha256, size}` type declared here.
 */

/** The portable `target_stack` values (storage-identity §5.1), redrawn locally per C1. */
export type TargetStackV1 = "rust-ratatui" | "go-bubbletea" | "js-opentui" | "generic";

/**
 * `.termcraft/project.toml`'s five semantic fields (storage-identity §5.1), minus nothing —
 * this is the whole portable manifest, deliberately narrow: no active page, active chat,
 * backend, model, effort, preview/UI setting, session id, or Git status lives here (§5.1,
 * §16.1) — see `WorkspaceStateV1` below for all of that.
 */
export interface ProjectManifestV1 {
  readonly projectId: string;
  readonly name: string;
  /** UTC RFC 3339. */
  readonly createdAt: string;
  readonly targetStack: TargetStackV1;
  /** Ordered, duplicate-free: listing/tab order, NOT page identity allocation (§5.1). */
  readonly pages: readonly PageSlug[];
}

export type PreviewSizeModeV1 = "auto" | "preset" | "custom";
export type PreviewSizePresetV1 = "80x24" | "120x40";
export type ColorCapabilityV1 = "truecolor" | "256" | "16";
export type RenderModeV1 = "static" | "interactive";

/** One `(chatId, sessionScopeId)` checkpoint (storage-identity §6.2) — see `session-checkpoint.ts` for the port that reads/advances these. */
export interface SessionCheckpointV1 {
  readonly chatId: string;
  readonly sessionScopeId: string;
  readonly sessionId: string;
  readonly recordCount: number;
  readonly prefixHash: Sha256Hex;
}

/** The optional typed resource-limit overrides (storage-identity §6.1, projections §16.1). Every key absent means the compiled default applies. */
export interface ResourceLimitOverridesV1 {
  readonly diagnosticsQuotaBytes?: number;
  readonly renderCacheQuotaBytes?: number;
  readonly exportWorkers?: number;
  readonly previewFps?: number;
  readonly operationsLogSegmentBytes?: number;
  readonly operationsLogRetentionSegments?: number;
  readonly silenceTimeoutSeconds?: number;
  readonly absoluteTurnDeadlineMinutes?: number;
}

/**
 * `.termcraft/workspace.local.toml`'s complete field set (storage-identity §6.1) —
 * MACHINE-LOCAL, hard-excluded from Git, never copied into portable state. Composer
 * drafts, focus, popups, selection, transient errors, context telemetry, and Git status
 * are deliberately absent (§6.1) — those are live Kernel state, not persisted here.
 */
export interface WorkspaceStateV1 {
  /** `null` = unset; falls back to the first listed manifest page. */
  readonly activePageSlug: PageSlug | null;
  /** `null` = unset; falls back to the newest valid chat by header `createdAt`. */
  readonly activeChatId: string | null;
  readonly backend: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly previewSizeMode: PreviewSizeModeV1;
  readonly previewSizePreset: PreviewSizePresetV1 | null;
  readonly previewCustomWidth: number | null;
  readonly previewCustomHeight: number | null;
  readonly themeOverride: string | null;
  readonly colorCapability: ColorCapabilityV1 | null;
  readonly renderMode: RenderModeV1;
  readonly fullscreenPreview: boolean;
  readonly sessionCheckpoints: readonly SessionCheckpointV1[];
  readonly resourceLimits: ResourceLimitOverridesV1;
}

/**
 * The read result of `workspace.local.toml` (storage-identity §6.1's "a corrupt file is
 * preserved, reported, and ignored in favor of in-memory defaults" — `corrupt: true` still
 * carries safe-default `state`, never throws the read away silently). `missing` is the
 * ordinary "never written yet" case, not an error.
 */
export interface WorkspaceStateReadV1 {
  readonly state: WorkspaceStateV1;
  readonly missing: boolean;
  readonly corrupt: boolean;
}

/** A held `ProjectLease` (storage-identity §9) minus its OS-handle internals — core needs only that one is held, not how. */
export interface ProjectLeaseIdentityV1 {
  readonly root: string;
}

export interface ProjectStore {
  readonly root: string;
  readonly lease: ProjectLeaseIdentityV1;
  readManifest(): Promise<FailureDtoV1 | ProjectManifestV1>;
  /**
   * `.termcraft/project.toml`'s own raw hash+size ({@link ReadSetFileSnapshotV1}) — closes
   * "Gap 4" (`core/kernel/model/handlers/turn.ts`'s own header, kernel-assembly Task 9):
   * `readManifest()` returns the PARSED `ProjectManifestV1` DTO, never the raw bytes/hash
   * `turn.start` needs for `AdmissionWorkspaceMaterialV1.readSet.manifest`
   * (turn-durability §7.5's own CAS baseline) — no other method on this port, `StagingService`,
   * or anywhere else in `KernelDeps` can build one honestly. Port + fake only here — the real
   * adapter (WP-2) reads `project.toml`'s own bytes directly off disk, mirroring
   * `StagingService.readCandidateFile`'s identical division (`core/ports/staging.ts`).
   */
  readManifestSnapshot(): Promise<FailureDtoV1 | ReadSetFileSnapshotV1>;
  readWorkspaceState(): Promise<FailureDtoV1 | WorkspaceStateReadV1>;
  /**
   * `model.select` (kernel-command-contract §8.2: "Validate backend capability and store
   * the machine-local selection") — one of the six commands blocker B3 names as
   * unreachable through `store`'s current public surface — and every other machine-local
   * preference write (preview size, theme override, fullscreen, …) share `store`'s
   * `local-state-write` `project-mutation` kind. `patch` merges onto the CURRENT state
   * (composed from the then-current local file, matching `store/transaction`'s own
   * `buildWorkspaceLocalOperation`) rather than requiring the caller to reconstruct the
   * whole document to change one field.
   */
  writeWorkspaceState(patch: Partial<WorkspaceStateV1>): Promise<FailureDtoV1 | undefined>;
  /** Releases the lease; every other project-scoped port becomes unsafe to use after this resolves. */
  close(): Promise<void>;
}

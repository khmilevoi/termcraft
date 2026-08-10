// `core/ports/` — the whole set of contracts `core` CONSUMES (docs/architecture/
// code-structure.md §7: "core imports entities/ and its own ports/, nothing else"). Every
// export below is pure data/interface — no Reatom, no I/O — so `core`'s own logic can be
// exercised against in-memory fakes long before `main.ts` exists to inject the real
// adapters (`store`, `agent`, `gate`, `host`).
//
// Decision C1 (this slice's plan §3): only `agent/types.ts` is genuinely liftable
// verbatim (`agent-backend.ts`); every other port here is a NARROW, core-owned redraw over
// `entities/` + local DTOs, never an import of the upstream module's own types — that
// upstream module's tagged errors map to this ring's `FailureDtoV1` (`core/protocol`) at
// the adapter boundary the composition root wires in a later phase.
//
// Decision C2: adapters MAY import `core/ports/*` TYPE-ONLY to prove they satisfy a port
// (one definition, both sides) — never the reverse. Nothing under `core/ports/` imports
// `store`, `agent`, `gate`, or `host`, even type-only; see `agent-backend.ts`'s header for
// where the resulting conformance check belongs instead.

// ---- agent (verbatim lift + the registry code-structure §8 requires) -----------------
export type {
  AgentBackend,
  AgentHealthState,
  AgentInfo,
  AgentRun,
  AgentRunOutcome,
  AgentTask,
  BackendCapabilities,
  BackendErrorCause,
  FencedEvent,
  ModelCapability,
  ReasoningEffort,
  SeedRecord,
  SessionPlan,
  SessionScopeInput,
  SessionWorkspaceBinding,
} from "./agent-backend";
export type { AgentRegistry } from "./agent-registry";

// ---- agent prompt library (phase-8 WP-3) ------------------------------------------------
export type { AgentPromptContextV1, AgentPromptSource } from "./agent-prompt";

// ---- project lifecycle -----------------------------------------------------------------
export type {
  ColorCapabilityV1,
  PreviewSizeModeV1,
  PreviewSizePresetV1,
  ProjectLeaseIdentityV1,
  ProjectManifestV1,
  ProjectStore,
  RenderModeV1,
  ResourceLimitOverridesV1,
  SessionCheckpointV1,
  TargetStackV1,
  WorkspaceStateReadV1,
  WorkspaceStateV1,
} from "./project-store";

// ---- chats, pages, pins -----------------------------------------------------------------
export type {
  ChatHandleV1,
  ChatHeaderV1,
  ChatListingEntryV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatPageCursorV1,
  ChatReader,
} from "./chat-store";
export type { DesignTreeFileV1, DesignTreeReader, PageMutations } from "./design-store";
export type { PinMutations, PinReader } from "./pin-store";

// ---- turn transactions + the project-write mutex ----------------------------------------
export type {
  AppendBaseV1,
  ChangedDesignFileOpV1,
  FileImageV1,
  ResolvedPinAppendV1,
  TurnAdmissionInputV1,
  TurnCommitV1,
  TurnFinalizeInputV1,
  TurnReadSetV1,
  TurnTerminalizeInputV1,
  TurnTerminalRecordV1,
  TurnTransactionService,
} from "./turn-transactions";
export type { ProjectWriteCoordinator, ProjectWritePermit } from "./project-write";

// ---- export publication ----------------------------------------------------------------
export type {
  ExportPointerFileV1,
  ExportPointerV1,
  ExportPublicationV1,
  ExportPublishOperationModeV1,
  ExportPublishOperationV1,
  ExportPublishPlanV1,
  ExportPublishPort,
} from "./export-publish";
export { EXPORT_POINTER_TARGET, exportPointerV1Schema } from "./export-publish";

// ---- staging, trust, projections, session checkpoint, recovery --------------------------
export type {
  CandidatePageSetV1,
  CreateTurnWorkspaceInputV1,
  ReadSetAppendBaseV1,
  ReadSetFileSnapshotV1,
  StagedFileV1,
  StagedTurnReadSetV1,
  StagingRuntimeDocV1,
  StagingService,
  StagingTreeFileV1,
  TurnWorkspaceV1,
} from "./staging";
export type { GitIdentityV1, TrustGate, TrustSubjectV1 } from "./trust";
export type {
  DiagnosticsCache,
  DiagnosticsEntryV1,
  DiagnosticsKeyV1,
  ExportRenderKeyV1,
  PageMetaCache,
  PageMetaEntryV1,
  PageMetaKeyV1,
  RenderCache,
  RenderEntryV1,
} from "./projections";
export type { ResumeVerdictV1, SessionCheckpointService } from "./session-checkpoint";
export type {
  OrphanTurnOutcomeV1,
  RecoveryOutcomeV1,
  RecoveryService,
  TransactionClassificationV1,
} from "./recovery";

// ---- gate ---------------------------------------------------------------------------------
export type {
  GateClosureV1,
  GateErrorKindV1,
  GateErrorV1,
  GatePageDescriptorV1,
  GateRunner,
  GateRunResultV1,
  GateWarningKindV1,
  GateWarningV1,
  ManifestSliceResultV1,
  ManifestSliceV1,
  PageMetaExtractionV1,
  RunTreeResultV1,
} from "./gate-runner";
export { PAGE_META_EXTRACTOR_VERSION } from "./gate-runner";

// ---- preview, host supervisor, export render -----------------------------------------------
export type {
  ColorV1,
  InteractionModeV1,
  PreviewFrameCoordinatesV1,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewIdentityV1,
  PreviewSession,
  StyledRunV1,
  TerminalCapabilitiesV1,
} from "./preview-session";
export type {
  HostModeV1,
  HostSessionSpecV1,
  HostSupervisorPort,
  SupervisorEventV1,
} from "./host-supervisor";
export type {
  ExportRenderPoolBoundsV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RuntimeDeclarationBundleV1,
} from "./export-render";

// ---- Git (declared only — no MVP implementation) -------------------------------------------
export type {
  CommitEntryV1,
  GitHistory,
  GitProjectStateV1,
  GitRepositoryStateV1,
  PageGitStateV1,
  PageHistoryPageV1,
  PageHistoryRequestV1,
  PageIndexStateV1,
  PageTrackingStateV1,
} from "./git-history";
export type {
  CommitPathImageV1,
  CommitPlanV1,
  CommitResultV1,
  CommitScopeV1,
  GitCommitter,
} from "./git-committer";

/**
 * A zero-cost, compile-time-only conformance check: `Impl` must be assignable to `Port`, or
 * this line itself fails `tsc`. An adapter module type-only-imports this alongside the port
 * it implements (decision C2) and writes one line —
 *
 * ```ts
 * import type { AgentBackend as CoreAgentBackend, AssertConforms } from "core/ports"
 * type _Check = AssertConforms<CoreAgentBackend, ReturnType<typeof createProductionClaudeBackend>>
 * ```
 *
 * — so a future edit that lets the port and its real implementation drift apart fails the
 * typecheck at the adapter's own file, not silently at `main.ts` composition in phase 8.
 * `Impl` is constrained to `extends Port` rather than checked with a conditional type so the
 * error surfaces as an ordinary "not assignable" diagnostic, not a bespoke tuple message.
 * This is a pure type — it has no runtime component and nothing to unit-test; `bun test`
 * cannot observe a type-level assignability failure, only `bun x tsc --noEmit` can.
 */
export type AssertConforms<Port, Impl extends Port> = Impl;

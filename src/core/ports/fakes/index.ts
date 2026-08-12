// `core/ports/fakes/` — in-memory, zero-I/O implementations of every port declared under
// `core/ports/` (this slice's task brief). They exist so 6E, 6F, and 6G can drive turn
// orchestration, project startup, preview, and export end to end against deterministic
// doubles: no spawned process, no disk, no clock drift, and no wall-clock/random source
// anywhere in this directory except the one call-time timestamp (`chat-store.ts`'s
// `create()`) that takes an injected `infrastructure/clock` `Clock`.
//
// Every fake is INDEPENDENT — it owns only its own port's state and does not reach into a
// sibling fake's state (e.g. `turn-transactions.ts`'s fake does not update
// `chat-store.ts`'s fake when it "admits" a user record). A real adapter may share state
// across two of these ports internally (the real `store` almost certainly backs both
// `ChatReader`/`ChatMutations` and the chat-append half of `TurnTransactionService` with
// one JSONL file); the ORCHESTRATION CODE under test in 6E-6G is what ties fakes together,
// the same way the composition root wires real adapters — it is not this ring's job to
// simulate that coupling on the fakes' behalf.
//
// Every fake is INSPECTABLE (an ordered `calls` log, typed per method so a test can both
// filter by method and read call arguments without casting) and PROGRAMMABLE (`failNext`
// for ports whose method returns `FailureDtoV1 | T`, or a port-specific one-shot queue —
// `scriptRecoverOutcome`, `queueRunPageResult`, `queueQueryResult`, `queueHealth` — for the
// handful of methods whose own failure/outcome shape is not `FailureDtoV1`). Every fake's
// structural conformance to its port is asserted at compile time via `AssertConforms`
// (`core/ports/index.ts`) at the bottom of its own file — `bun x tsc --noEmit` fails the
// build the moment a fake and its port drift apart, before any orchestration code is ever
// wired to it.

export type { AgentRegistryCall, FakeAgentRegistry } from "./agent-registry";
export { createFakeAgentRegistry } from "./agent-registry";

export type { AgentBackendCall, FakeAgentBackend } from "./agent-backend";
export { createFakeAgentBackend } from "./agent-backend";

export type { AgentPromptSourceCall, FakeAgentPromptSource } from "./agent-prompt";
export { createFakeAgentPromptSource } from "./agent-prompt";

export type {
  ProjectStoreCall,
  ProjectStoreFailableMethod,
  FakeProjectStore,
} from "./project-store";
export { createFakeProjectStore } from "./project-store";

export type { ChatStoreCall, ChatStoreFailableMethod, FakeChatStore } from "./chat-store";
export { createFakeChatStore } from "./chat-store";

export type {
  DesignStoreCall,
  DesignStoreFailableMethod,
  DesignTreeFileSeedV1,
  FakeDesignPageV1,
  FakeDesignStore,
} from "./design-store";
export {
  createFakeDesignStore,
  createFakeDesignStoreForPages,
  defaultFakeEntry,
  fakeDesignTreeFile,
} from "./design-store";

export type { PinStoreCall, PinStoreFailableMethod, FakePinStore } from "./pin-store";
export { createFakePinStore } from "./pin-store";

export type {
  TurnTransactionCall,
  TurnTransactionFailableMethod,
  FakeTurnTransactionService,
} from "./turn-transactions";
export { createFakeTurnTransactionService } from "./turn-transactions";

export type {
  FakeCallSequence,
  FakeProjectWriteCoordinator,
  ProjectWriteCoordinatorCall,
} from "./project-write";
export { createFakeProjectWriteCoordinator, createSequence } from "./project-write";

export type { ExportPublishCall, FakeExportPublish } from "./export-publish";
export { createFakeExportPublish } from "./export-publish";

export type { StagingCall, StagingFailableMethod, FakeStagingService } from "./staging";
export { createFakeStagingService } from "./staging";

export type { TrustGateCall, TrustGateFailableMethod, FakeTrustGate } from "./trust";
export { createFakeTrustGate } from "./trust";

// ---- design-system sources ----------------------------------------------------------------
export type {
  DesignSystemSourceFailableMethod,
  FakeDesignSystemSource,
  FakeDesignSystemSourceCall,
  FakeDesignSystemSourceOptions,
} from "./design-system-source";
export { createFakeDesignSystemSource } from "./design-system-source";

export type {
  DesignSystemInstallFailableMethod,
  FakeDesignSystemInstall,
  FakeDesignSystemInstallCall,
  RecordedDesignSystemInstallV1,
} from "./design-system-install";
export { createFakeDesignSystemInstall } from "./design-system-install";

export type {
  DiagnosticsCacheCall,
  FakeDiagnosticsCache,
  FakePageMetaCache,
  FakeRenderCache,
  PageMetaCacheCall,
  RenderCacheCall,
} from "./projections";
export {
  createFakeDiagnosticsCache,
  createFakePageMetaCache,
  createFakeRenderCache,
} from "./projections";

export type {
  SessionCheckpointCall,
  SessionCheckpointFailableMethod,
  FakeSessionCheckpointService,
} from "./session-checkpoint";
export { createFakeSessionCheckpointService } from "./session-checkpoint";

export type { RecoveryCall, RecoveryFailableMethod, FakeRecoveryService } from "./recovery";
export { createFakeRecoveryService } from "./recovery";

export type { GateRunnerCall, FakeGateRunner } from "./gate-runner";
export { createFakeGateRunner } from "./gate-runner";

export type {
  PreviewSessionCall,
  PreviewSessionFailableMethod,
  FakePreviewSession,
} from "./preview-session";
export { createFakePreviewSession } from "./preview-session";

export type {
  HostSupervisorCall,
  HostSupervisorFailableMethod,
  FakeHostSupervisorPort,
} from "./host-supervisor";
export { createFakeHostSupervisorPort } from "./host-supervisor";

export type {
  ExportRenderCall,
  ExportRenderFailableMethod,
  FakeExportRenderPort,
} from "./export-render";
export { createFakeExportRenderPort } from "./export-render";

export type { GitHistoryCall, GitHistoryFailableMethod, FakeGitHistory } from "./git-history";
export { createFakeGitHistory } from "./git-history";

export type {
  GitCommitterCall,
  GitCommitterFailableMethod,
  FakeGitCommitter,
} from "./git-committer";
export { createFakeGitCommitter } from "./git-committer";

// Machine-local turn-workspace staging (storage-identity §4/§6.2; turn-durability §6.2/§7.2;
// projections §9). Every turn gets a unique, create-new workspace under a stable per-project
// sandbox parent keyed by `projectKey` — never inside `.termcraft/`, never cleared and reused.
// Populating it copies every listed canonical page, the manifest slice, `RUNTIME.md`, and the
// runtime type declarations while hashing, then durably persists `turn.json`.
//
// The post-run immutable-candidate assembly (turn-durability §5.4/§7.3) is `store/safe-fs`'s
// already-landed `snapshotToCandidate`, not duplicated here. The copy-on-write staging
// accelerator (projections §9) is deferred — this ships the baseline streaming copy only.
export type {
  AbsPath,
  CanonicalPageReadSetEntry,
  CreateTurnWorkspaceInput,
  PinsReadSetEntry,
  ReadSetAppendBase,
  ReadSetFileSnapshot,
  Sha256Hex,
  StagedFile,
  StagedTurnReadSet,
  StagingFsDeps,
  StagingPageSource,
  StagingRuntimeDoc,
  StagingStore,
  StagingStoreDeps,
  TurnWorkspace,
} from "./types"

export type { ProjectKeyInput } from "./model/project-key"
export { computeProjectKey } from "./model/project-key"

export type { StagingError } from "./model/staging-store"
export {
  InvalidIdentityError,
  TurnJsonWriteError,
  WorkspaceCollisionError,
  createStagingStore,
  nodeStagingFsDeps,
  sandboxParentDir,
  turnDir,
  turnJsonPath,
  turnWorkspaceDir,
  turnsParentDir,
} from "./model/staging-store"

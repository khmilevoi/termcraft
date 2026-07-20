// `SafeProjectFs` — the mandatory managed-filesystem capability, not a convenience
// wrapper (turn-durability §5; storage-identity §4). It is rooted at an OPENED root
// rather than a string join, and every managed access passes, in order: the §5.1 path
// grammar, the no-follow component walk with the tag-agnostic reparse-point rejection and
// the Spike F realpath escape check, the §5.2 file identity and type rules, and the §5.3
// limit table — checked before allocation and again while streaming. §5.4's immutable
// candidate is produced by `snapshotToCandidate`.
//
// Filesystem safety passing does not imply Gate validity, and Gate validity never
// bypasses filesystem safety.
export type {
  ManagedNamespace,
  ManagedRoot,
  ManagedRootKind,
  NoFollowDeps,
  SafeFsError,
  SafeFsStat,
  SafeProjectFs,
  SafeProjectFsDeps,
} from "./types"

export {
  MAX_COMPONENT_BYTES,
  MAX_PATH_BYTES,
  MAX_PATH_COMPONENTS,
  NameCollisionError,
  PathRuleError,
  WINDOWS_RESERVED_DEVICE_NAMES,
  detectNameCollisions,
  foldName,
  validateRelativePath,
} from "./model/path-rules"

export {
  FsAccessError,
  PathEscapeError,
  ReparsePointRejectedError,
  assertWithinRoot,
  createSafeProjectFs,
  isNotFound,
  nodeSafeFsDeps,
  openManagedRoot,
  resolveManagedPath,
} from "./model/no-follow"

export {
  IdentityChangedError,
  LeafRejectedError,
  UnsafeHardlinkError,
  checkIdentityUnchanged,
  checkManagedDirectory,
  checkManagedLeaf,
  detectDuplicateIdentity,
  identityKey,
} from "./model/leaf-identity"

export type { LimitBudget, NamespaceLimit, RootAggregateLimit } from "./model/limits"
export {
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  JSONL_MAX_SERIALIZED_OBJECT_BYTES,
  KiB,
  MiB,
  NAMESPACE_LIMITS,
  ROOT_LIMITS,
  StorageLimitExceededError,
  UnknownNamespaceError,
  classifyNamespace,
  createLimitBudget,
} from "./model/limits"

export type { CandidateDeps, CandidateFile, CandidateSink, CandidateSnapshot, IncrementalHash, SourceHandle } from "./model/candidate"
export { WorkspaceChangedDuringSnapshotError, nodeCandidateDeps, snapshotToCandidate } from "./model/candidate"

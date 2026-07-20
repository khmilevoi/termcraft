import type { PageSlug } from "entities/page"
import type { Clock } from "infrastructure/clock"
import type { CandidateDeps, ManagedNamespace } from "store/safe-fs"

import type { InvalidIdentityError, StagingError, TurnJsonWriteError, WorkspaceCollisionError } from "./model/staging-store"

export type { InvalidIdentityError, StagingError, TurnJsonWriteError, WorkspaceCollisionError }

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed
 * relative path. `store/types.ts` (T19) owns the shared alias; this local declaration
 * keeps the submodule self-contained until then.
 */
export type AbsPath = string

/** Lowercase-hex SHA-256. */
export type Sha256Hex = string

/**
 * The narrow slice of `store/safe-fs`'s tested candidate-copy primitives (`model/candidate.ts`)
 * that staging needs: create-new directory/file creation, a streaming source reader, and an
 * incremental hasher. Reusing the TYPE (not just the production function) keeps the two
 * submodules' write primitives from silently drifting apart; `nodeStagingFsDeps` (in
 * `model/staging-store.ts`) wires it to `store/safe-fs`'s `nodeCandidateDeps` directly.
 */
export type StagingFsDeps = Pick<CandidateDeps, "mkdirAll" | "mkdirNew" | "openSource" | "createNewSink" | "createHash" | "removeTree">

/** One canonical page to stage, already resolved to an absolute source path by the caller. */
export interface StagingPageSource {
  readonly pageSlug: PageSlug
  readonly absSourcePath: AbsPath
}

/**
 * One `RUNTIME.md` or runtime type-declaration file to stage (turn-durability §7.2). Its
 * relative path is validated against the workspace's `agent-runtime-doc` namespace grammar
 * (`store/safe-fs`'s `classifyNamespace`) before anything is copied.
 */
export interface StagingRuntimeDoc {
  readonly relPath: string
  readonly absSourcePath: AbsPath
}

/** A `project.toml` or canonical-page snapshot in the send-time read set — the same fact `store/transaction`'s `FileImage.file` variant carries, re-declared locally per this codebase's own convention (e.g. `store/transaction/model/plan.ts`'s `preparedAppendSchema`) rather than importing across `store/` submodules the plan does not wire as dependent. */
export interface ReadSetFileSnapshot {
  readonly sha256: Sha256Hex
  readonly size: number
}

/** A JSONL append-base snapshot in the send-time read set — the exact length and prefix hash of the valid bytes read at admission time (mirrors `store/jsonl`'s `AppendBase`, re-declared locally for the same reason as {@link ReadSetFileSnapshot}). */
export interface ReadSetAppendBase {
  readonly length: number
  readonly prefixSha256: Sha256Hex
}

/** One canonical page's snapshot in the send-time read set. `snapshot: null` marks an expected-absence entry — a potential new target that did not exist at admission time (turn-durability §7.2 step 4: the CAS still re-checks that absence at finalization). */
export interface CanonicalPageReadSetEntry {
  readonly pageSlug: PageSlug
  readonly snapshot: ReadSetFileSnapshot | null
}

/** One comments log's append base in the send-time read set — every page whose selection or sent pins contributed context (turn-durability §7.2 step 4). */
export interface PinsReadSetEntry {
  readonly pageSlug: PageSlug
  readonly base: ReadSetAppendBase
}

/**
 * The full send-time read set turn-durability §7.2 step 4 requires `turn.json` to persist,
 * and §7.5's pre-intent CAS re-hashes: `project.toml`'s image (`null` only for the
 * theoretical not-yet-existing-manifest case), every canonical page exposed to the agent
 * (including expected-absence entries for a potential new target), the captured chat's
 * append base, and every contributing comments log's append base.
 *
 * Captured once at admission and durably persisted by `createTurnWorkspace` (this fixes
 * minor finding #4: before this field existed, `turn.json` had no place to hold any of
 * this, so the read set survived only in a caller's process memory and was lost across a
 * restart between admission and finalization). A phase-6 caller reads it back off
 * `TurnWorkspace.readSet` (or `turn.json` directly) and translates it 1:1 into
 * `store/transaction`'s own `TurnReadSet` (`FileImage`/`AppendBase`-shaped) for the
 * finalization CAS — that translation is the caller's job, not this module's.
 */
export interface TurnReadSet {
  readonly manifest: ReadSetFileSnapshot | null
  readonly canonicalPages: readonly CanonicalPageReadSetEntry[]
  readonly chat: ReadSetAppendBase
  readonly pins: readonly PinsReadSetEntry[]
}

/**
 * Everything `createTurnWorkspace` needs to populate one turn's workspace (turn-durability
 * §6.2/§7.2). `manifestSlice` is the already-assembled `pages.json` bytes: unlike the
 * canonical pages and runtime docs, the manifest slice is synthesized fresh per turn — not
 * copied from an existing file — so it is handed in as bytes rather than a source path.
 * `readSet` is the send-time read set captured at admission (see {@link TurnReadSet}) —
 * durably persisted in `turn.json` rather than kept only in caller memory.
 */
export interface CreateTurnWorkspaceInput {
  readonly canonicalProjectRoot: AbsPath
  readonly projectId: string
  readonly turnId: string
  readonly targetChatId: string
  readonly pages: readonly StagingPageSource[]
  readonly manifestSlice: Uint8Array
  readonly runtimeDocs: readonly StagingRuntimeDoc[]
  readonly readSet: TurnReadSet
}

/** One file staged into the workspace, with the hash computed while it was copied. */
export interface StagedFile {
  readonly relPath: string
  readonly namespace: ManagedNamespace
  readonly sha256: Sha256Hex
  readonly size: number
}

/**
 * The populated turn workspace (turn-durability §6.2), returned only after `turn.json` has
 * been durably persisted and verified.
 */
export interface TurnWorkspace {
  readonly turnId: string
  readonly root: AbsPath
  readonly turnJsonPath: AbsPath
  readonly files: readonly StagedFile[]
  readonly totalBytes: number
  readonly readSet: TurnReadSet
}

/** Everything `createStagingStore` needs; every impure boundary is injected. */
export interface StagingStoreDeps {
  /** The OS per-user termcraft state root that owns the sandbox parent (storage-identity §4). */
  readonly userStateRoot: AbsPath
  readonly clock: Clock
  readonly fs: StagingFsDeps
  /** Durable atomic install (storage-identity §4.2) — `turn.json`'s only write path. */
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => Error | undefined
}

/**
 * The machine-local turn-workspace staging store (turn-durability §6.2/§7.2; projections
 * §9). `snapshotCandidate` — the post-run immutable-candidate assembly of §5.4/§7.3 — is
 * `store/safe-fs`'s already-landed `snapshotToCandidate`, not duplicated here: this
 * submodule owns only the pre-run creation of the turn's writable workspace.
 */
export interface StagingStore {
  createTurnWorkspace(input: CreateTurnWorkspaceInput): Promise<StagingError | TurnWorkspace>
}

import type { FailureDtoV1, Sha256Hex } from "core/protocol"
import type { PageSlug } from "entities/page"

/**
 * `StagingService`: the machine-local turn-workspace lifecycle `core` drives around one
 * agent attempt (turn-durability §6.2, §7.2, §7.3, §5.4) — populate a fresh writable
 * workspace, freeze the finished run into an immutable Gate-facing candidate, and release
 * the workspace once the candidate exists (or the turn is abandoned). Narrowed from
 * `store/sandbox`'s `StagingStore` + `store/safe-fs`'s `snapshotToCandidate` per decision
 * C1 — neither store type is imported here.
 *
 * `retireWorkspace` corresponds to the "candidate and workspace-retirement exposure" this
 * slice's plan (§2, 6D scope) lists as upstream work `store` still owes: today's
 * `StagingStore` only creates a workspace and never exposes a release method, so the real
 * adapter for this method does not exist yet at the time this port is declared — a sibling
 * agent's job in this same slice, not a blocker on the port's shape.
 */

/** One canonical page to stage, already resolved to a readable source path by the caller. */
export interface StagingPageSourceV1 {
  readonly pageSlug: PageSlug
  readonly sourcePath: string
}

/** One `RUNTIME.md` or runtime type-declaration file to stage (turn-durability §7.2). */
export interface StagingRuntimeDocV1 {
  readonly relPath: string
  readonly sourcePath: string
}

/** A `project.toml` or canonical-page snapshot in the send-time read set. */
export interface ReadSetFileSnapshotV1 {
  readonly sha256: Sha256Hex
  readonly size: number
}

/** A JSONL append-base snapshot in the send-time read set. */
export interface ReadSetAppendBaseV1 {
  readonly length: number
  readonly prefixSha256: Sha256Hex
}

/**
 * The STAGING-TIME read set (decision C6 — renamed `StagedTurnReadSet` on the store side to
 * stop colliding with `store/transaction`'s finalize-time `TurnReadSet`; see
 * `turn-transactions.ts`'s header for the full note and the 1:1-translation seam this type
 * feeds). `snapshot: null` on a canonical-page entry marks an expected-absence — a
 * potential new target that did not exist at admission time.
 */
export interface StagedTurnReadSetV1 {
  readonly manifest: ReadSetFileSnapshotV1 | null
  readonly canonicalPages: readonly { readonly pageSlug: PageSlug; readonly snapshot: ReadSetFileSnapshotV1 | null }[]
  readonly chat: ReadSetAppendBaseV1
  readonly pins: readonly { readonly pageSlug: PageSlug; readonly base: ReadSetAppendBaseV1 }[]
}

export interface CreateTurnWorkspaceInputV1 {
  readonly turnId: string
  readonly targetChatId: string
  readonly pages: readonly StagingPageSourceV1[]
  /** The already-assembled `pages.json` bytes — synthesized fresh per turn, never copied from an existing file. */
  readonly manifestSlice: Uint8Array
  readonly runtimeDocs: readonly StagingRuntimeDocV1[]
  readonly readSet: StagedTurnReadSetV1
}

export interface StagedFileV1 {
  readonly relPath: string
  readonly sha256: Sha256Hex
  readonly size: number
}

/** The populated turn workspace, returned only after its manifest has been durably persisted and verified. */
export interface TurnWorkspaceV1 {
  readonly turnId: string
  readonly root: string
  readonly files: readonly StagedFileV1[]
  readonly totalBytes: number
  readonly readSet: StagedTurnReadSetV1
}

/** The immutable, Gate-facing candidate produced by freezing a finished workspace (§5.4). */
export interface CandidatePageSetV1 {
  readonly root: string
  readonly files: readonly StagedFileV1[]
  readonly totalBytes: number
}

export interface StagingService {
  /** Populate one turn's writable workspace: canonical pages, the manifest slice, runtime docs, and the durably-persisted read set (§6.2/§7.2). */
  createTurnWorkspace(input: CreateTurnWorkspaceInputV1): Promise<FailureDtoV1 | TurnWorkspaceV1>
  /** Enumerate + copy the finished workspace into an immutable candidate OUTSIDE the workspace (§5.4/§7.3) — a hostile workspace passes zero bytes to any consumer on a validation failure. */
  snapshotToCandidate(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | CandidatePageSetV1>
  /** Release the machine-local workspace once the candidate is frozen or the turn is abandoned. */
  retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined>
}

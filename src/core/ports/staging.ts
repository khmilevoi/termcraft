import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { PageSlug } from "entities/page";

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

/**
 * One file of the canonical design tree to stage, already resolved to a readable absolute
 * path by the caller. `relPath` is TREE-relative (`pages/home.tsx`), and the workspace copy
 * lands at the SAME tree-relative path — which is what makes design §10's hard requirement
 * hold: because the two trees agree, no import specifier is ever rewritten on apply.
 */
export interface StagingTreeFileV1 {
  readonly relPath: string;
  readonly sourcePath: string;
}

/** One `RUNTIME.md` or runtime type-declaration file to stage (turn-durability §7.2). */
export interface StagingRuntimeDocV1 {
  readonly relPath: string;
  readonly sourcePath: string;
}

/** A `project.toml` or canonical-page snapshot in the send-time read set. */
export interface ReadSetFileSnapshotV1 {
  readonly sha256: Sha256Hex;
  readonly size: number;
}

/** A JSONL append-base snapshot in the send-time read set. */
export interface ReadSetAppendBaseV1 {
  readonly length: number;
  readonly prefixSha256: Sha256Hex;
}

/**
 * The STAGING-TIME read set (decision C6 — renamed `StagedTurnReadSet` on the store side to
 * stop colliding with `store/transaction`'s finalize-time `TurnReadSet`; see
 * `turn-transactions.ts`'s header for the full note and the 1:1-translation seam this type
 * feeds). `snapshot: null` on a design-file entry marks an expected-absence — a potential
 * new target that did not exist at admission time.
 */
export interface StagedTurnReadSetV1 {
  readonly manifest: ReadSetFileSnapshotV1 | null;
  readonly designFiles: readonly {
    readonly relPath: string;
    readonly snapshot: ReadSetFileSnapshotV1 | null;
  }[];
  readonly chat: ReadSetAppendBaseV1;
  readonly pins: readonly { readonly pageSlug: PageSlug; readonly base: ReadSetAppendBaseV1 }[];
}

/**
 * NOTE (multi-file design tree design §4, §10): `pages.json` is no longer synthesized per
 * turn from `project.toml`. It is a real file inside the canonical tree that the agent edits
 * directly, and staging copies it verbatim like every other tree file. There is no manifest
 * slice any more.
 */
export interface CreateTurnWorkspaceInputV1 {
  readonly turnId: string;
  readonly targetChatId: string;
  readonly treeFiles: readonly StagingTreeFileV1[];
  readonly runtimeDocs: readonly StagingRuntimeDocV1[];
  readonly readSet: StagedTurnReadSetV1;
}

export interface StagedFileV1 {
  readonly relPath: string;
  readonly sha256: Sha256Hex;
  readonly size: number;
}

/** The populated turn workspace, returned only after its manifest has been durably persisted and verified. */
export interface TurnWorkspaceV1 {
  readonly turnId: string;
  readonly root: string;
  readonly files: readonly StagedFileV1[];
  readonly totalBytes: number;
  readonly readSet: StagedTurnReadSetV1;
}

/** The immutable, Gate-facing candidate produced by freezing a finished workspace (§5.4). */
export interface CandidatePageSetV1 {
  readonly root: string;
  readonly files: readonly StagedFileV1[];
  readonly totalBytes: number;
}

export interface StagingService {
  /** Populate one turn's writable workspace: canonical pages, the manifest slice, runtime docs, and the durably-persisted read set (§6.2/§7.2). */
  createTurnWorkspace(input: CreateTurnWorkspaceInputV1): Promise<FailureDtoV1 | TurnWorkspaceV1>;
  /** Enumerate + copy the finished workspace into an immutable candidate OUTSIDE the workspace (§5.4/§7.3) — a hostile workspace passes zero bytes to any consumer on a validation failure. */
  snapshotToCandidate(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | CandidatePageSetV1>;
  /** Release the machine-local workspace once the candidate is frozen or the turn is abandoned. */
  retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined>;
  /**
   * Reads one frozen candidate file's own bytes back by its `relPath` (§5.4/§7.3) — closes
   * "Gap 3" (`core/kernel/model/handlers/turn.ts`'s own header, kernel-assembly Task 9 Step
   * C3): `TurnCandidateV1` (`core/turns/model/candidate.ts`) carries only each file's
   * `sha256`/`size`, never its bytes ("the diff never touches content" — that file's own
   * header) — so `runTurn`'s `RunTurnInputV1.buildValidationInput`/`buildFinalizeInput` have
   * no way to turn a frozen candidate back into Gate's `manifestText`/page `source` RAW TEXT
   * (`core/ports/gate-runner.ts`) or finalize's changed-page byte content without this
   * method. `root` is `CandidatePageSetV1.root` (the SAME candidate `snapshotToCandidate`
   * just froze); `relPath` must be one of that candidate's own `StagedFileV1.relPath`
   * entries — reading any other path, or a candidate that was never frozen (or has since
   * been released), is out of contract and returns a `FailureDtoV1`, never fabricated bytes.
   * Port + fake only here — the real adapter is WP-2's job (mirrors the identical division
   * this file's own header already states for `retireWorkspace`).
   */
  readCandidateFile(root: string, relPath: string): Promise<FailureDtoV1 | Uint8Array>;
  /**
   * Release the immutable candidate directory `snapshotToCandidate` froze, once the turn
   * that owns it has reached its own terminal outcome — finalize committed, or the turn
   * terminalized (kernel-assembly Task 13). The candidate deliberately lives outside
   * `retireWorkspace`'s reach (that method only ever clears the turn's `workspace/` tree —
   * see its own doc above) so a Gate/finalize consumer can still `readCandidateFile` after
   * the workspace itself is gone; this is the method that finally releases it once nothing
   * needs it anymore. Closes the "KNOWN GAP, DEFERRED" `store/adapters/staging.ts`'s own
   * header previously left open — `core` (the only party that knows when a turn's candidate
   * is truly done) now has a way to say so.
   *
   * CONTAINMENT IS PART OF THE CONTRACT, NOT AN IMPLEMENTATION DETAIL (review finding #3):
   * `root` is NOT "any path" — it is expected to be a `CandidatePageSetV1.root` THIS SAME
   * `StagingService` instance itself returned from an earlier `snapshotToCandidate` call.
   * `core` never mints or derives this string itself; it only ever forwards a value it
   * already received back from this port. Two distinct outcomes for an out-of-contract
   * `root`, both never destructive:
   *   - Nothing exists at `root`: idempotent no-op (`undefined`) — the ordinary
   *     "already-gone or never-frozen" case `retireWorkspace` already established the
   *     convention for. There is nothing at risk to protect, so this is indistinguishable
   *     from — and treated the same as — retiring a candidate THIS instance already froze
   *     whose directory some other process (or an earlier `retireCandidate` call) already
   *     removed.
   *   - Something exists at `root` but it is NOT a candidate this instance itself froze
   *     (an arbitrary directory, a caller mistake, a path-traversal attempt): refused
   *     (`FailureDtoV1`), and the real adapter never calls its own delete primitive for it.
   *     A `root` outside the contract is never silently deleted just because the target
   *     happens to be a real, well-formed directory.
   */
  retireCandidate(root: string): Promise<FailureDtoV1 | undefined>;
}

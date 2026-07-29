import type { FailureDtoV1, Sha256Hex } from "core/protocol";

import type { AssertConforms } from "../index";
import type {
  CandidatePageSetV1,
  CreateTurnWorkspaceInputV1,
  StagedFileV1,
  StagingService,
  TurnWorkspaceV1,
} from "../staging";

/**
 * In-memory {@link StagingService} fake (6D task brief; re-keyed to the design tree by plan
 * Task 7). `createTurnWorkspace` synthesizes a deterministic root path and file list from
 * `input.turnId`/`treeFiles`/`runtimeDocs` — no real disk write happens, so
 * `snapshotToCandidate`, `retireWorkspace` and `retireCandidate` only need to track which
 * workspace/candidate ids are live, not copy or delete real bytes (kernel-assembly Task 13's
 * own header).
 */

/** A deterministic, valid-looking 64-hex-char {@link Sha256Hex} derived from a seed — no crypto, no randomness. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

export type StagingFailableMethod =
  | "createTurnWorkspace"
  | "snapshotToCandidate"
  | "retireWorkspace"
  | "readCandidateFile"
  | "retireCandidate";

export type StagingCall =
  | { readonly method: "createTurnWorkspace"; readonly input: CreateTurnWorkspaceInputV1 }
  | { readonly method: "snapshotToCandidate"; readonly turnId: string }
  | { readonly method: "retireWorkspace"; readonly turnId: string; readonly effective: boolean }
  | { readonly method: "readCandidateFile"; readonly root: string; readonly relPath: string }
  | { readonly method: "retireCandidate"; readonly root: string; readonly effective: boolean };

export interface FakeStagingService extends StagingService {
  readonly calls: readonly StagingCall[];
  failNext(method: StagingFailableMethod, failure: FailureDtoV1): void;
  /**
   * Registers `root` as "a real, existing directory this fake never froze itself" — the only
   * way this in-memory fake can honestly model `retireCandidate`'s own port doc outcome 2
   * (review finding #8): something exists at `root` but it is not one of THIS instance's own
   * candidates, so it is refused (`FailureDtoV1`), never silently no-op'd. Without this, a
   * genuinely never-seen root (nothing exists there) and a real-but-foreign root (something
   * exists, but not ours) were indistinguishable in this fake's model — both returned
   * `undefined` — so no test could exercise how `core` handles a retire REFUSAL, on the one
   * method that deletes directories. A root never passed here still hits the idempotent
   * "nothing exists" no-op `retireWorkspace` already established the convention for.
   */
  seedForeignCandidateRoot(root: string): void;
}

export function createFakeStagingService(): FakeStagingService {
  const live = new Set<string>();
  const calls: StagingCall[] = [];

  const queues: Record<StagingFailableMethod, FailureDtoV1[]> = {
    createTurnWorkspace: [],
    snapshotToCandidate: [],
    retireWorkspace: [],
    readCandidateFile: [],
    retireCandidate: [],
  };

  // Which candidate roots `snapshotToCandidate` has frozen and `retireCandidate` has not
  // yet released — mirrors `live`'s identical bookkeeping for workspaces one level up.
  const liveCandidateRoots = new Set<string>();

  // Roots `seedForeignCandidateRoot` has marked as "real, but never frozen by this instance"
  // — the fake's only way to model the port doc's outcome-2 refusal (review finding #8). See
  // `FakeStagingService.seedForeignCandidateRoot`'s own doc.
  const foreignCandidateRoots = new Set<string>();

  // Per-workspace synthetic content, keyed by `turnId` — built once, at `createTurnWorkspace`
  // time, as deterministic (never random) synthetic bytes derived from each staged file's own
  // `sourcePath`, since `StagingTreeFileV1`/`StagingRuntimeDocV1` carry only a `sourcePath`
  // STRING, never real bytes, for this fake to copy — `design/pages.json` is an ordinary tree
  // file now (plan Task 7: no more `manifestSlice` real-byte special case). Copied into
  // `contentByCandidateRoot` (keyed by the frozen candidate's own root) once
  // `snapshotToCandidate` runs, so `readCandidateFile` can look a relPath up by the SAME root
  // a caller actually holds after freezing — never by `turnId`, which `readCandidateFile`'s
  // own port signature never takes.
  const contentByTurnId = new Map<string, ReadonlyMap<string, Uint8Array>>();
  const contentByCandidateRoot = new Map<string, ReadonlyMap<string, Uint8Array>>();

  function failNext(method: StagingFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function createTurnWorkspace(
    input: CreateTurnWorkspaceInputV1,
  ): Promise<FailureDtoV1 | TurnWorkspaceV1> {
    calls.push({ method: "createTurnWorkspace", input });
    const queued = queues.createTurnWorkspace.shift();
    if (queued !== undefined) return queued;

    // Staged under `design/<relPath>` — the fixed fake-fidelity path (this file's own
    // header): `store/adapters/staging.ts`'s real `createStagingAdapter` stages the whole
    // tree under `design/` (multi-file design tree design §10), and this fake's `relPath`s
    // must keep matching or the fidelity test this comment refers to
    // (`store/adapters/staging.test.ts`) silently stops proving anything. `design/pages.json`
    // is just another entry in `input.treeFiles` now (plan Task 7) — this fake never
    // fabricates one itself, matching the port's own doc: "no invented pages.json".
    const treeFileEntries: StagedFileV1[] = input.treeFiles.map((file) => ({
      relPath: `design/${file.relPath}`,
      sha256: fakeSha256Hex(file.sourcePath),
      size: 0,
    }));
    const runtimeFiles: StagedFileV1[] = input.runtimeDocs.map((doc) => ({
      relPath: doc.relPath,
      sha256: fakeSha256Hex(doc.sourcePath),
      size: 0,
    }));
    const files = [...treeFileEntries, ...runtimeFiles];

    // Every staged file gets deterministic synthetic content derived from its own
    // `sourcePath` — see this function's own header comment on `contentByTurnId`.
    const content = new Map<string, Uint8Array>();
    for (const file of input.treeFiles) {
      content.set(
        `design/${file.relPath}`,
        new TextEncoder().encode(`fake-tree-file:${file.sourcePath}`),
      );
    }
    for (const doc of input.runtimeDocs) {
      content.set(doc.relPath, new TextEncoder().encode(`fake-runtime-doc:${doc.sourcePath}`));
    }
    contentByTurnId.set(input.turnId, content);

    live.add(input.turnId);
    return {
      turnId: input.turnId,
      root: `/fake-turn-workspace/${input.turnId}`,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      readSet: input.readSet,
    };
  }

  async function snapshotToCandidate(
    workspace: TurnWorkspaceV1,
  ): Promise<FailureDtoV1 | CandidatePageSetV1> {
    calls.push({ method: "snapshotToCandidate", turnId: workspace.turnId });
    const queued = queues.snapshotToCandidate.shift();
    if (queued !== undefined) return queued;
    const root = `/fake-candidate/${workspace.turnId}`;
    // Copied from `contentByTurnId` (never re-keyed by `turnId` again after this point) —
    // `readCandidateFile` only ever receives the CANDIDATE's own root, matching the real
    // port's contract (a candidate is the one thing `runTurn` still holds a reference to
    // once the workspace itself has been retired).
    contentByCandidateRoot.set(root, contentByTurnId.get(workspace.turnId) ?? new Map());
    liveCandidateRoots.add(root);
    return { root, files: workspace.files, totalBytes: workspace.totalBytes };
  }

  function candidateFileNotFound(root: string, relPath: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `no candidate file "${relPath}" under "${root}"`,
      details: { root, relPath },
    };
  }

  async function readCandidateFile(
    root: string,
    relPath: string,
  ): Promise<FailureDtoV1 | Uint8Array> {
    calls.push({ method: "readCandidateFile", root, relPath });
    const queued = queues.readCandidateFile.shift();
    if (queued !== undefined) return queued;
    const bytes = contentByCandidateRoot.get(root)?.get(relPath);
    if (bytes === undefined) return candidateFileNotFound(root, relPath);
    return bytes;
  }

  async function retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined> {
    const effective = live.has(workspace.turnId);
    calls.push({ method: "retireWorkspace", turnId: workspace.turnId, effective });
    const queued = queues.retireWorkspace.shift();
    if (queued !== undefined) return queued;
    live.delete(workspace.turnId);
    return undefined;
  }

  function foreignCandidateRootRefusal(root: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `refused to retire "${root}": not a candidate this instance froze`,
      details: { root },
    };
  }

  /**
   * Idempotent for a genuinely never-seen root (matching the port's own doc: retiring an
   * already-gone or never-frozen root is a no-op, never a failure) — but refuses a root
   * `seedForeignCandidateRoot` marked as "real, but not ours" (review finding #8), matching
   * the real adapter's own containment refusal for a root outside its tracked set.
   */
  async function retireCandidate(root: string): Promise<FailureDtoV1 | undefined> {
    const effective = liveCandidateRoots.has(root);
    calls.push({ method: "retireCandidate", root, effective });
    const queued = queues.retireCandidate.shift();
    if (queued !== undefined) return queued;
    if (!effective && foreignCandidateRoots.has(root)) return foreignCandidateRootRefusal(root);
    liveCandidateRoots.delete(root);
    return undefined;
  }

  function seedForeignCandidateRoot(root: string): void {
    foreignCandidateRoots.add(root);
  }

  return {
    createTurnWorkspace,
    snapshotToCandidate,
    retireWorkspace,
    readCandidateFile,
    retireCandidate,
    calls,
    failNext,
    seedForeignCandidateRoot,
  };
}

type _Conforms = AssertConforms<StagingService, FakeStagingService>;

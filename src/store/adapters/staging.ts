import path from "node:path";

import type {
  AssertConforms,
  CandidatePageSetV1,
  CreateTurnWorkspaceInputV1,
  StagedFileV1,
  StagingService,
  TurnWorkspaceV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import {
  FsAccessError,
  PathEscapeError,
  createSafeProjectFs,
  isNotFound,
  nodeCandidateDeps,
  nodeSafeFsDeps,
  openManagedRoot,
  snapshotToCandidate as snapshotStoreCandidate,
} from "store/safe-fs";
import type { CreateTurnWorkspaceInput, TurnWorkspace } from "store/sandbox";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";

// `createStagingAdapter` — the `StagingService` port over `OpenProject.staging` plus
// `store/safe-fs`'s `snapshotToCandidate` (plan Task 2).
//
// RESOLVED GAP (honest adapter-level composition, documented): store's
// `CreateTurnWorkspaceInput` needs `canonicalProjectRoot`/`projectId`, neither of which
// `CreateTurnWorkspaceInputV1` (core's port DTO) carries — both are project-session-wide
// facts, not per-call ones, so they are derived from `OpenProject` itself:
// `canonicalProjectRoot` from `path.dirname(open.safeFs.root.realPath)` (the already-
// realpath-resolved `.termcraft` parent — the same canonicalization `openManagedRoot`
// already performed at open time), `projectId` from `open.manifest.read()`.
//
// RESOLVED GAP (honest adapter-level composition, documented): `snapshotToCandidate` needs
// a `destRoot` OUTSIDE the workspace tree that survives `retireWorkspace` (which deletes the
// WHOLE `turns/<turnId>/` tree the workspace lives under — `store/sandbox/model/
// staging-store.ts`'s `retireWorkspace`). Neither `OpenProject` nor `StoreAdapterDeps`
// exposes `userStateRoot`/`projectKey` to build a sibling path the way `store/sandbox`'s own
// `sandboxParentDir`/`turnsParentDir` helpers do. This adapter instead walks up from the
// ALREADY-KNOWN `TurnWorkspaceV1.root` (`.../sandboxes/<projectKey>/turns/<turnId>/workspace`,
// `turnWorkspaceDir`'s own layout) three levels to that same sandbox parent, then places the
// candidate at a sibling `candidates/<turnId>/` — never inside `turns/<turnId>/`, so
// `retireWorkspace` never touches it. FRAGILE, FLAGGED: this depends on `store/sandbox`'s
// exact directory-nesting depth staying `sandboxParentDir/turns/<turnId>/workspace`; a future
// change to that layout would silently break this derivation without a compile error.
//
// `retireWorkspace` needs the real `TurnWorkspace.turnJsonPath` (its only field the real
// `retireWorkspace` reads), which `TurnWorkspaceV1` never carries — this adapter caches the
// real `TurnWorkspace` `createTurnWorkspace` produced, keyed by `turnId`, and looks it back up
// here; a `turnId` this adapter never staged (or already retired) is a no-op, matching
// `retireWorkspace`'s own idempotent "already gone is not an error" convention.
//
// `readCandidateFile` opens the frozen candidate as its OWN managed root (`kind: "candidate"`)
// rather than reading through `open.safeFs` (which is scoped to `.termcraft`, not the
// sandbox-area candidate root the plan's own text assumed) — `SafeProjectFs.readFile`'s own
// namespace grammar (`design/pages/<slug>.tsx`, `design/pages.json`, `RUNTIME.md`, `*.d.ts` —
// the exact staged-file inventory, multi-file design tree design §10) plus its
// physical-presence check already deliver the port's "out-of-contract paths return
// FailureDtoV1, never fabricated bytes" without this adapter separately tracking each
// candidate's file list.
//
// RESOLVED GAP (kernel-assembly Task 13): candidate directories this adapter creates under
// `candidates/<turnId>/` (see `candidateDestRoot` below) used to be NEVER removed —
// `snapshotToCandidate` deliberately places them outside `turns/<turnId>/` so they survive
// `retireWorkspace` (by design — a Gate/finalize consumer may still need to `readCandidateFile`
// after the workspace itself is gone), but nothing called anything to release a candidate once
// ITS OWN lifecycle later ended. `retireCandidate` below closes that: `StagingService` now
// exposes it (`core/ports/staging.ts`), and `core/turns/model/finalize.ts`/`terminalize.ts`
// call it (via `core/turns/model/run-turn.ts`'s dependency wiring) once a turn reaches its own
// terminal outcome (committed, or terminalized).
//
// CONTAINMENT (review finding #3, fixed alongside the above): `retireCandidate` deletes real
// bytes, so unlike every read-only method here it cannot trust a caller-supplied `root`
// unvalidated. `liveCandidateRoots` (below) tracks every root THIS adapter instance itself
// produced via `snapshotToCandidate` — the only roots `retireCandidate` will ever pass to
// `removeTree`. A `root` that resolves to a real, existing directory NOT in that set is
// refused (`FailureDtoV1`), never deleted, however innocuous `openManagedRoot`'s own no-follow
// check found it (that check only proves "a real, non-reparse-point directory", not "one of
// OUR candidates" — it has no notion of a containment boundary on its own). A `root` that
// does not resolve to anything at all (never staged by this instance, or already retired) is
// the same idempotent no-op `retireWorkspace` already established the convention for — see
// this method's own port doc for the full two-outcome contract. `removeTree` is the same
// best-effort, warn-and-swallow primitive every other cleanup call site in this ring uses
// (`store/safe-fs/model/candidate.ts`'s `nodeCandidateDeps`); a real removal failure is
// REPORTED via `console.warn` inside `removeTree` itself rather than propagated as a
// `FailureDtoV1` — the turn's outcome is already durable by the time this runs, so a cleanup
// failure must never retroactively fail it (this method's own port doc).

function toStoreInput(
  input: CreateTurnWorkspaceInputV1,
  canonicalProjectRoot: string,
  projectId: string,
): CreateTurnWorkspaceInput {
  return {
    canonicalProjectRoot,
    projectId,
    turnId: input.turnId,
    targetChatId: input.targetChatId,
    treeFiles: input.treeFiles.map((file) => ({
      relPath: file.relPath,
      absSourcePath: file.sourcePath,
    })),
    runtimeDocs: input.runtimeDocs.map((doc) => ({
      relPath: doc.relPath,
      absSourcePath: doc.sourcePath,
    })),
    readSet: input.readSet,
  };
}

function toWorkspaceV1(workspace: TurnWorkspace): TurnWorkspaceV1 {
  const files: StagedFileV1[] = workspace.files.map((file) => ({
    relPath: file.relPath,
    sha256: file.sha256,
    size: file.size,
  }));
  return {
    turnId: workspace.turnId,
    root: workspace.root,
    files,
    totalBytes: workspace.totalBytes,
    readSet: workspace.readSet,
  };
}

/**
 * `workspace.root` is `turnWorkspaceDir(userStateRoot, projectKey, turnId)` —
 * `.../sandboxes/<projectKey>/turns/<turnId>/workspace` (`store/sandbox/model/
 * staging-store.ts`). Three levels up is the project's stable sandbox parent
 * (`sandboxParentDir`); a sibling `candidates/<turnId>/` there survives
 * `retireWorkspace`'s whole-`turns/<turnId>/`-tree removal. See this file's header.
 */
function candidateDestRoot(workspaceRoot: string, turnId: string): string {
  const sandboxParent = path.dirname(path.dirname(path.dirname(workspaceRoot)));
  return path.join(sandboxParent, "candidates", turnId);
}

/**
 * True when any `/`- or `\`-delimited component of `raw` is exactly `..` (review finding
 * #3's explicit "a `..`-bearing path" test case). Checked as an up-front, filesystem-free
 * refusal in `retireCandidate` rather than relying on where the string happens to resolve —
 * see that method's own doc.
 */
function hasTraversalSegment(raw: string): boolean {
  return raw.split(/[\\/]+/).some((segment) => segment === "..");
}

export function createStagingAdapter(deps: StoreAdapterDeps): StagingService {
  const { open } = deps;
  const safeFsDeps = nodeSafeFsDeps();
  const candidateDeps = nodeCandidateDeps();

  // Keyed by `turnId` — see this file's header on why `retireWorkspace` needs the real
  // `TurnWorkspace` (its `turnJsonPath`) that `TurnWorkspaceV1` never carries.
  const liveWorkspaces = new Map<string, TurnWorkspace>();

  // Every candidate root THIS adapter instance itself froze via `snapshotToCandidate` — the
  // containment allowlist `retireCandidate` checks before ever deleting anything (see this
  // file's header, "CONTAINMENT"). Deliberately never pruned on retire: a real removal makes
  // the directory itself disappear, so a repeat `retireCandidate` call for the SAME root hits
  // the "nothing exists there" idempotent branch regardless of set membership — keeping the
  // entry around costs nothing and avoids reintroducing a second "was this ever ours" check.
  const liveCandidateRoots = new Set<string>();

  async function createTurnWorkspace(
    input: CreateTurnWorkspaceInputV1,
  ): Promise<FailureDtoV1 | TurnWorkspaceV1> {
    const manifest = await open.manifest.read();
    if (manifest instanceof Error) return toFailureDto(manifest);

    const canonicalProjectRoot = path.dirname(open.safeFs.root.realPath);
    const result = await open.staging.createTurnWorkspace(
      toStoreInput(input, canonicalProjectRoot, manifest.projectId),
    );
    if (result instanceof Error) return toFailureDto(result);

    liveWorkspaces.set(result.turnId, result);
    return toWorkspaceV1(result);
  }

  async function snapshotToCandidate(
    workspace: TurnWorkspaceV1,
  ): Promise<FailureDtoV1 | CandidatePageSetV1> {
    const source = openManagedRoot({ kind: "workspace", path: workspace.root, deps: safeFsDeps });
    if (source instanceof Error) return toFailureDto(source);

    const destRoot = candidateDestRoot(workspace.root, workspace.turnId);

    // A Gate retry re-freezes WITHIN THE SAME TURN, and `destRoot` is keyed by `turnId` alone —
    // so the second attempt aimed `mkdirNew` at the directory the first attempt had already
    // created and died `EEXIST` -> `PERSISTENCE_FAILED`. That made every gate-rejected turn fail
    // deterministically on its own retry: the documented 3-retry budget could never run past the
    // first rejection. (`retireCandidate` runs only at terminalization — end of turn — so it
    // never covered the gap BETWEEN attempts.)
    //
    // Retiring through `retireCandidate` rather than deleting here on the spot is deliberate: it
    // is the one path that already enforces the containment allowlist (`liveCandidateRoots`) plus
    // the traversal/no-follow refusals, so this adds no second recursive-delete path to audit.
    // Guarded by the same allowlist so a `destRoot` this adapter never froze is left untouched
    // and the create-new collision still surfaces honestly.
    if (liveCandidateRoots.has(destRoot)) {
      const retired = await retireCandidate(destRoot);
      if (retired !== undefined) return retired;
    }

    // `snapshotToCandidate`'s own `mkdirNew(destRoot)` is deliberately non-recursive (create-
    // new semantics for the candidate itself) — the `candidates/` PARENT under the sandbox
    // root is shared across every turn's candidate and must exist first, exactly like
    // `store/sandbox`'s own `mkdirAll(turnsParentDir(...))` ensures its sibling `turns/`
    // parent before `mkdirNew`ing one turn's own directory.
    const parentReady = candidateDeps.mkdirAll(path.dirname(destRoot));
    if (parentReady instanceof Error) return toFailureDto(parentReady);

    const snapshot = snapshotStoreCandidate({ source, destRoot, deps: candidateDeps });
    if (snapshot instanceof Error) return toFailureDto(snapshot);

    // Recorded verbatim (not realpath-resolved) — this is the EXACT string threaded back to
    // a caller as `CandidatePageSetV1.root`, and the exact string `retireCandidate` will
    // later receive back unchanged (see this file's header, "CONTAINMENT").
    liveCandidateRoots.add(snapshot.root);

    return { root: snapshot.root, files: snapshot.files, totalBytes: snapshot.totalBytes };
  }

  async function retireWorkspace(workspace: TurnWorkspaceV1): Promise<FailureDtoV1 | undefined> {
    const real = liveWorkspaces.get(workspace.turnId);
    if (real === undefined) return undefined; // already retired, or never staged by this adapter — idempotent

    const result = await open.staging.retireWorkspace(real);
    liveWorkspaces.delete(workspace.turnId);
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function readCandidateFile(
    root: string,
    relPath: string,
  ): Promise<FailureDtoV1 | Uint8Array> {
    const candidateRoot = openManagedRoot({ kind: "candidate", path: root, deps: safeFsDeps });
    if (candidateRoot instanceof Error) return toFailureDto(candidateRoot);

    const safeFs = createSafeProjectFs(candidateRoot, safeFsDeps);
    const bytes = safeFs.readFile(relPath);
    if (bytes instanceof Error) return toFailureDto(bytes);
    return bytes;
  }

  /**
   * Candidate cleanup — see this file's header ("RESOLVED GAP (kernel-assembly Task 13)" and
   * "CONTAINMENT"). Three outcomes, in order:
   *
   * 1. `root` is malformed on its face (empty, or carries a `..` traversal segment) — refused
   *    before touching the filesystem at all. Caught here rather than left to
   *    `openManagedRoot`/realpath resolution because whether a `..`-bearing string happens to
   *    resolve to something that exists is an accident of the current working directory and
   *    filesystem layout, not something this method's safety should depend on.
   * 2. `openManagedRoot` cannot find anything at `root` (`isNotFound`) — the idempotent
   *    "already-gone or never-frozen" no-op the port doc documents, matching
   *    `retireWorkspace`'s own convention. Any OTHER `openManagedRoot` failure (a reparse
   *    point, a non-directory leaf) is a real failure, reported via `toFailureDto`.
   * 3. `root` resolves to a real, existing directory: only removed if it is one THIS adapter
   *    instance itself froze (`liveCandidateRoots`); otherwise refused — `openManagedRoot`'s
   *    own no-follow check proves the target is safe to descend into, not that it is one of
   *    OUR candidates, so containment is enforced here rather than assumed from that check.
   *
   * `removeTree` never returns an error to this function (it warns and swallows its own
   * failures), so a successful containment check always resolves to `undefined`; the
   * signature still returns `FailureDtoV1 | undefined` to match the port's own convention.
   */
  async function retireCandidate(root: string): Promise<FailureDtoV1 | undefined> {
    if (root.length === 0 || hasTraversalSegment(root)) {
      return toFailureDto(
        new PathEscapeError({
          relPath: root,
          resolved: root,
          root: "<staging adapter: refused before resolving — empty or `..`-bearing root>",
        }),
      );
    }

    const candidateRoot = openManagedRoot({ kind: "candidate", path: root, deps: safeFsDeps });
    if (candidateRoot instanceof Error) {
      // `openManagedRoot`'s failure is only ever an `FsAccessError` (a missing path) OR one
      // of the no-follow/type-rejection classes (`ReparsePointRejectedError`,
      // `LeafRejectedError`) — `isNotFound` is typed against `FsAccessError` specifically
      // (it reads `.code`, which only that class carries), so the "already gone" idempotent
      // check only applies once the class itself is confirmed.
      if (candidateRoot instanceof FsAccessError && isNotFound(candidateRoot)) return undefined;
      return toFailureDto(candidateRoot);
    }

    if (!liveCandidateRoots.has(root)) {
      return toFailureDto(
        new PathEscapeError({
          relPath: root,
          resolved: candidateRoot.realPath,
          root: "<staging adapter's own tracked candidate roots>",
        }),
      );
    }

    candidateDeps.removeTree(candidateRoot.realPath);
    return undefined;
  }

  return {
    createTurnWorkspace,
    snapshotToCandidate,
    retireWorkspace,
    readCandidateFile,
    retireCandidate,
  };
}

type _Conforms = AssertConforms<StagingService, ReturnType<typeof createStagingAdapter>>;

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
  createSafeProjectFs,
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
// namespace grammar (`pages/<slug>.tsx`, `pages.json`, `RUNTIME.md`, `*.d.ts` — the exact
// staged-file inventory) plus its physical-presence check already deliver the port's
// "out-of-contract paths return FailureDtoV1, never fabricated bytes" without this adapter
// separately tracking each candidate's file list.

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
    pages: input.pages.map((page) => ({
      pageSlug: page.pageSlug,
      absSourcePath: page.sourcePath,
    })),
    manifestSlice: input.manifestSlice,
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

export function createStagingAdapter(deps: StoreAdapterDeps): StagingService {
  const { open } = deps;
  const safeFsDeps = nodeSafeFsDeps();
  const candidateDeps = nodeCandidateDeps();

  // Keyed by `turnId` — see this file's header on why `retireWorkspace` needs the real
  // `TurnWorkspace` (its `turnJsonPath`) that `TurnWorkspaceV1` never carries.
  const liveWorkspaces = new Map<string, TurnWorkspace>();

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
    // `snapshotToCandidate`'s own `mkdirNew(destRoot)` is deliberately non-recursive (create-
    // new semantics for the candidate itself) — the `candidates/` PARENT under the sandbox
    // root is shared across every turn's candidate and must exist first, exactly like
    // `store/sandbox`'s own `mkdirAll(turnsParentDir(...))` ensures its sibling `turns/`
    // parent before `mkdirNew`ing one turn's own directory.
    const parentReady = candidateDeps.mkdirAll(path.dirname(destRoot));
    if (parentReady instanceof Error) return toFailureDto(parentReady);

    const snapshot = snapshotStoreCandidate({ source, destRoot, deps: candidateDeps });
    if (snapshot instanceof Error) return toFailureDto(snapshot);

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

  return { createTurnWorkspace, snapshotToCandidate, retireWorkspace, readCandidateFile };
}

type _Conforms = AssertConforms<StagingService, ReturnType<typeof createStagingAdapter>>;

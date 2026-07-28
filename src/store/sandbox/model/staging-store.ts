import path from "node:path";

import * as errore from "errore";

import { DESIGN_DIRNAME } from "entities/design-tree";
import { isCanonicalUuidv7 } from "infrastructure/uuid";
import type {
  CandidateSink,
  FsAccessError,
  LeafRejectedError,
  UnknownNamespaceError,
  UnsafeHardlinkError,
} from "store/safe-fs";
import {
  IdentityChangedError,
  checkIdentityUnchanged,
  checkManagedLeaf,
  classifyNamespace,
  nodeCandidateDeps,
} from "store/safe-fs";

import type {
  AbsPath,
  CreateTurnWorkspaceInput,
  Sha256Hex,
  StagedFile,
  StagedTurnReadSet,
  StagingFsDeps,
  StagingStore,
  StagingStoreDeps,
  TurnWorkspace,
} from "../types";
import { computeProjectKey } from "./project-key";

// ---- errors ---------------------------------------------------------------------

/**
 * turn-durability §6.2: "If the turn path already exists, admission fails with
 * `workspace_collision`; termcraft never clears it and retries under the same id." A new
 * user message always mints a fresh `turnId` (§6.2), so a real collision means the same
 * turn id was asked to stage twice — never repaired by deleting and rewriting.
 */
export class WorkspaceCollisionError extends errore.createTaggedError({
  name: "WorkspaceCollisionError",
  message: "workspace_collision: $path already exists and is never cleared or reused",
}) {}

/** `projectId`/`turnId`/`targetChatId` must be the canonical lowercase UUIDv7 text (roadmap identity registry). */
export class InvalidIdentityError extends errore.createTaggedError({
  name: "InvalidIdentityError",
  message: "$field is not a canonical UUIDv7: $value",
}) {}

/** `turn.json` could not be durably persisted (turn-durability §7.2 step 5: "Persist and verify `turn.json`"). */
export class TurnJsonWriteError extends errore.createTaggedError({
  name: "TurnJsonWriteError",
  message: "failed to persist turn.json at $path",
}) {}

/** Any rejection `store/sandbox` can return — a `_tag`-discriminated union for propagating callers. */
export type StagingError =
  | WorkspaceCollisionError
  | InvalidIdentityError
  | TurnJsonWriteError
  | UnknownNamespaceError
  | LeafRejectedError
  | UnsafeHardlinkError
  | IdentityChangedError
  | FsAccessError;

// ---- layout (turn-durability §6.2) -----------------------------------------------

/** `{userStateRoot}/sandboxes/<projectKey>/` — the stable per-project sandbox parent. */
export function sandboxParentDir(userStateRoot: AbsPath, projectKey: Sha256Hex): AbsPath {
  return path.join(userStateRoot, "sandboxes", projectKey);
}

/** `.../turns/` — shared and idempotently created across every turn of one project. */
export function turnsParentDir(userStateRoot: AbsPath, projectKey: Sha256Hex): AbsPath {
  return path.join(sandboxParentDir(userStateRoot, projectKey), "turns");
}

/** `.../turns/<turnId>/` — the create-new-only turn path (§6.2's `workspace_collision` unit). */
export function turnDir(userStateRoot: AbsPath, projectKey: Sha256Hex, turnId: string): AbsPath {
  return path.join(turnsParentDir(userStateRoot, projectKey), turnId);
}

/** `.../turns/<turnId>/workspace/` — the agent's cwd and only writable root (turn-durability §6.3). */
export function turnWorkspaceDir(
  userStateRoot: AbsPath,
  projectKey: Sha256Hex,
  turnId: string,
): AbsPath {
  return path.join(turnDir(userStateRoot, projectKey, turnId), "workspace");
}

/** `.../turns/<turnId>/turn.json` — non-secret turn metadata plus the staged-file inventory (§6.2). */
export function turnJsonPath(
  userStateRoot: AbsPath,
  projectKey: Sha256Hex,
  turnId: string,
): AbsPath {
  return path.join(turnDir(userStateRoot, projectKey, turnId), "turn.json");
}

// ---- production fs wiring --------------------------------------------------------

/** The real Node/Bun bindings, reusing `store/safe-fs`'s already-tested streaming-copy primitives. */
export function nodeStagingFsDeps(): StagingFsDeps {
  const candidate = nodeCandidateDeps();
  return {
    mkdirAll: candidate.mkdirAll,
    mkdirNew: candidate.mkdirNew,
    openSource: candidate.openSource,
    createNewSink: candidate.createNewSink,
    createHash: candidate.createHash,
    removeTree: candidate.removeTree,
  };
}

// ---- small helpers ----------------------------------------------------------------

function isCollision(error: FsAccessError): boolean {
  return error.code === "EEXIST";
}

/** `mkdirNew` semantics, with an `EEXIST` failure translated to the domain `WorkspaceCollisionError`. */
function mkdirNewOrCollision(fsDeps: StagingFsDeps, absPath: AbsPath): StagingError | undefined {
  const made = fsDeps.mkdirNew(absPath);
  if (made instanceof Error)
    return isCollision(made) ? new WorkspaceCollisionError({ path: absPath }) : made;
  return undefined;
}

/** Close a sink whose copy already failed and propagate the original failure, not the close outcome. */
function closeSinkThen(sink: CandidateSink, error: StagingError): StagingError {
  const closed = sink.close();
  if (closed instanceof Error) console.warn("sandbox: staging sink close failed:", closed.message);
  return error;
}

/** Discard a turn tree WE created after a later step failed — never called before we own the path. */
function discard(fsDeps: StagingFsDeps, turnPath: AbsPath, error: StagingError): StagingError {
  fsDeps.removeTree(turnPath);
  return error;
}

function validateIdentities(input: CreateTurnWorkspaceInput): InvalidIdentityError | undefined {
  if (!isCanonicalUuidv7(input.projectId))
    return new InvalidIdentityError({ field: "projectId", value: input.projectId });
  if (!isCanonicalUuidv7(input.turnId))
    return new InvalidIdentityError({ field: "turnId", value: input.turnId });
  if (!isCanonicalUuidv7(input.targetChatId))
    return new InvalidIdentityError({ field: "targetChatId", value: input.targetChatId });
  return undefined;
}

// ---- copy ---------------------------------------------------------------------------

/**
 * Copy one canonical source file into the workspace while hashing it exactly once
 * (projections §9: "The Kernel computes each initial source hash while copying. It does
 * not make a second full source snapshot merely for diffing"). Rejects a hardlinked or
 * otherwise non-plain source (turn-durability §5.2; projections §9: "Hardlinks are
 * forbidden in staging and candidate assembly") and a source that changed identity between
 * open and the post-copy recheck (§5.2/§5.4) — the same open-once/recheck discipline
 * `store/safe-fs`'s candidate assembly uses.
 */
function copySourceFile(input: {
  absSourcePath: AbsPath;
  destPath: AbsPath;
  fs: StagingFsDeps;
}): StagingError | { sha256: Sha256Hex; size: number } {
  const handle = input.fs.openSource(input.absSourcePath);
  if (handle instanceof Error) return handle;

  const before = handle.stat();
  if (before instanceof Error) {
    handle.close();
    return before;
  }

  const rejected = checkManagedLeaf(input.absSourcePath, before);
  if (rejected instanceof Error) {
    handle.close();
    return rejected;
  }

  const sink = input.fs.createNewSink(input.destPath);
  if (sink instanceof Error) {
    handle.close();
    return sink;
  }

  const hash = input.fs.createHash();
  let copied = 0;
  for (;;) {
    const chunk = handle.read();
    if (chunk instanceof Error) {
      handle.close();
      return closeSinkThen(sink, chunk);
    }
    if (chunk === null) break;
    copied += chunk.byteLength;
    hash.update(chunk);
    const wrote = sink.write(chunk);
    if (wrote instanceof Error) {
      handle.close();
      return closeSinkThen(sink, wrote);
    }
  }

  const closed = sink.close();
  if (closed instanceof Error) {
    handle.close();
    return closed;
  }

  const after = handle.stat();
  handle.close();
  if (after instanceof Error) return after;

  const drifted = checkIdentityUnchanged(input.absSourcePath, before, after);
  if (drifted instanceof Error) return drifted;
  if (copied !== before.size) {
    return new IdentityChangedError({
      path: input.absSourcePath,
      reason: `copied ${copied} bytes but the source reported ${before.size}`,
    });
  }

  return { sha256: hash.digestHex(), size: copied };
}

/** Write an in-memory buffer as a create-new workspace file while hashing it (the `pages.json` manifest slice). */
function writeInlineFile(input: {
  destPath: AbsPath;
  bytes: Uint8Array;
  fs: StagingFsDeps;
}): StagingError | { sha256: Sha256Hex; size: number } {
  const sink = input.fs.createNewSink(input.destPath);
  if (sink instanceof Error) return sink;

  const hash = input.fs.createHash();
  hash.update(input.bytes);
  const wrote = sink.write(input.bytes);
  if (wrote instanceof Error) return closeSinkThen(sink, wrote);

  const closed = sink.close();
  if (closed instanceof Error) return closed;

  return { sha256: hash.digestHex(), size: input.bytes.byteLength };
}

// STOPGAP (documented, not silent — Task 8: `store/sandbox` — stage the tree,
// `docs/superpowers/plans/2026-07-28-design-tree-canonical-source.md`): `stageAllFiles` below
// still stages one `CreateTurnWorkspaceInput.pages` entry per page plus a separately-
// synthesized `manifestSlice`, the pre-design-tree shape — it does not yet copy the whole
// authored `design/**` tree 1:1, which is Task 8's job. What changes HERE, ahead of Task 8, is
// only the destination: every staged file now lands under {@link DESIGN_DIRNAME} (imported from
// `entities/design-tree`, the domain's own constant — `store/sandbox` is not the domain-free
// layer `store/safe-fs` is, so it imports the real thing rather than a paired literal) so its
// `namespace` (derived from the real `classifyNamespace`, never hardcoded) is honest under the
// new workspace grammar (`store/safe-fs`'s `classifyWorkspace`, which no longer recognizes a
// bare `pages/`).

/**
 * Stage every listed canonical page, the manifest slice, and every runtime doc into the
 * (already create-new) workspace directory (turn-durability §7.2's staging read set). A
 * runtime-doc relative path outside the workspace's `agent-runtime-doc` grammar is rejected
 * before it is opened; so is a page or manifest destination outside `design-source` — which
 * cannot actually happen for the fixed `design/pages/<slug>.tsx` / `design/pages.json`
 * shapes below, but going through `classifyNamespace` rather than a hardcoded namespace
 * keeps the staged `namespace` tag truthful by construction.
 */
function stageAllFiles(input: {
  workspacePath: AbsPath;
  source: CreateTurnWorkspaceInput;
  fs: StagingFsDeps;
}): StagingError | StagedFile[] {
  const files: StagedFile[] = [];

  // The manifest lands inside `design/` even with zero pages, so this directory is made
  // unconditionally — unlike the `pages/` subdirectory below, which only pages need.
  const madeDesignDir = input.fs.mkdirAll(path.join(input.workspacePath, DESIGN_DIRNAME));
  if (madeDesignDir instanceof Error) return madeDesignDir;

  if (input.source.pages.length > 0) {
    const madePagesDir = input.fs.mkdirAll(path.join(input.workspacePath, DESIGN_DIRNAME, "pages"));
    if (madePagesDir instanceof Error) return madePagesDir;
  }
  for (const page of input.source.pages) {
    const relPath = `${DESIGN_DIRNAME}/pages/${page.pageSlug}.tsx`;
    const namespace = classifyNamespace("workspace", relPath);
    if (namespace instanceof Error) return namespace;

    const destPath = path.join(
      input.workspacePath,
      DESIGN_DIRNAME,
      "pages",
      `${page.pageSlug}.tsx`,
    );
    const copied = copySourceFile({ absSourcePath: page.absSourcePath, destPath, fs: input.fs });
    if (copied instanceof Error) return copied;
    files.push({ relPath, namespace, sha256: copied.sha256, size: copied.size });
  }

  const manifestRelPath = `${DESIGN_DIRNAME}/pages.json`;
  const manifestNamespace = classifyNamespace("workspace", manifestRelPath);
  if (manifestNamespace instanceof Error) return manifestNamespace;

  const manifestDest = path.join(input.workspacePath, DESIGN_DIRNAME, "pages.json");
  const manifestWritten = writeInlineFile({
    destPath: manifestDest,
    bytes: input.source.manifestSlice,
    fs: input.fs,
  });
  if (manifestWritten instanceof Error) return manifestWritten;
  files.push({
    relPath: manifestRelPath,
    namespace: manifestNamespace,
    sha256: manifestWritten.sha256,
    size: manifestWritten.size,
  });

  for (const doc of input.source.runtimeDocs) {
    const namespace = classifyNamespace("workspace", doc.relPath);
    if (namespace instanceof Error) return namespace;

    const destPath = path.join(input.workspacePath, ...doc.relPath.split("/"));
    const parentDir = path.dirname(destPath);
    if (parentDir !== input.workspacePath) {
      const madeParent = input.fs.mkdirAll(parentDir);
      if (madeParent instanceof Error) return madeParent;
    }

    const copied = copySourceFile({ absSourcePath: doc.absSourcePath, destPath, fs: input.fs });
    if (copied instanceof Error) return copied;
    files.push({ relPath: doc.relPath, namespace, sha256: copied.sha256, size: copied.size });
  }

  return files;
}

/**
 * `turn.json` is a plain JSON file (neither TOML nor JSONL), so storage-identity §12 pins
 * its version field as `schemaVersion` (finding #4's naming half — this file previously used
 * `formatVersion`, the name reserved for TOML `format_version`/JSONL headers).
 * `readSet` is turn-durability §7.2 step 4's send-time read set (finding #4's persistence
 * half — previously absent from this record entirely, so it did not survive a restart).
 */
interface TurnJsonRecord {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly projectId: string;
  readonly targetChatId: string;
  readonly createdAt: string;
  readonly readSet: StagedTurnReadSet;
  readonly files: readonly StagedFile[];
}

// ---- the store --------------------------------------------------------------------

/**
 * The machine-local turn-workspace staging store (turn-durability §6.2/§7.2; projections
 * §9). Creation is CREATE-NEW at every level: the turn directory is never cleared and
 * reused, so any failure after it exists discards the whole tree we made rather than
 * leaving a partial workspace behind — but a pre-existing turn path we did NOT create is
 * left completely untouched and reported as `WorkspaceCollisionError`.
 *
 * DEFERRED (projections §9): the copy-on-write staging accelerator. This ships the
 * baseline streaming copy only, gated behind a future benchmark per the design.
 */
export function createStagingStore(deps: StagingStoreDeps): StagingStore {
  return {
    async createTurnWorkspace(input: CreateTurnWorkspaceInput) {
      const invalidId = validateIdentities(input);
      if (invalidId instanceof Error) return invalidId;

      const projectKey = computeProjectKey({
        canonicalProjectRoot: input.canonicalProjectRoot,
        projectId: input.projectId,
      });
      const turnPath = turnDir(deps.userStateRoot, projectKey, input.turnId);
      const workspacePath = turnWorkspaceDir(deps.userStateRoot, projectKey, input.turnId);
      const jsonPath = turnJsonPath(deps.userStateRoot, projectKey, input.turnId);

      // Shared across every turn of this project — idempotent, never ours alone to discard.
      const parentReady = deps.fs.mkdirAll(turnsParentDir(deps.userStateRoot, projectKey));
      if (parentReady instanceof Error) return parentReady;

      // The collision unit (§6.2): a pre-existing turn path is refused, untouched.
      const turnCreated = mkdirNewOrCollision(deps.fs, turnPath);
      if (turnCreated instanceof Error) return turnCreated;

      // From here on we own `turnPath`: any failure discards exactly the tree we made.
      const workspaceCreated = mkdirNewOrCollision(deps.fs, workspacePath);
      if (workspaceCreated instanceof Error) return discard(deps.fs, turnPath, workspaceCreated);

      const staged = stageAllFiles({ workspacePath, source: input, fs: deps.fs });
      if (staged instanceof Error) return discard(deps.fs, turnPath, staged);

      const record: TurnJsonRecord = {
        schemaVersion: 1,
        turnId: input.turnId,
        projectId: input.projectId,
        targetChatId: input.targetChatId,
        createdAt: deps.clock.now().toISOString(),
        readSet: input.readSet,
        files: staged,
      };
      const persisted = deps.durableWrite(
        jsonPath,
        new TextEncoder().encode(`${JSON.stringify(record)}\n`),
      );
      if (persisted instanceof Error)
        return discard(
          deps.fs,
          turnPath,
          new TurnJsonWriteError({ path: jsonPath, cause: persisted }),
        );

      const workspace: TurnWorkspace = {
        turnId: input.turnId,
        root: workspacePath,
        turnJsonPath: jsonPath,
        files: staged,
        totalBytes: staged.reduce((sum, file) => sum + file.size, 0),
        readSet: input.readSet,
      };
      return workspace;
    },

    async retireWorkspace(workspace: TurnWorkspace) {
      // The turn's WHOLE tree (`turns/<turnId>/`) — `workspace.root` names only the nested
      // `workspace/` subdirectory `turn.json` sits alongside, and a retired turn has no
      // further use for either. `removeTree` is a best-effort primitive (it warns and swallows
      // its own failures, matching every other cleanup call site in this file), so retiring an
      // already-gone or never-created turn is the same idempotent no-op.
      deps.fs.removeTree(path.dirname(workspace.turnJsonPath));
      return undefined;
    },
  };
}

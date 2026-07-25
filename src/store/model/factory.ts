import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

import type { ChatHeader, ChatSystemErrorRecord } from "entities/chat";
import { foldPins } from "entities/pin";
import { systemClock } from "infrastructure/clock";
import { durableFileWrite, flushDir, probeDurability } from "infrastructure/durability";
import { formatFsIdentity, isReparsePoint } from "infrastructure/fs-guard";
import { uuidv7 } from "infrastructure/uuid";
import {
  JSONL_LF,
  JSONL_MAX_PHYSICAL_LINE_BYTES,
  buildChatIndex,
  advanceSessionCheckpoint as computeAdvancedSessionCheckpoint,
  createNodeChatIndexPageStore,
  createNodeChatIndexStateStore,
  decodeChatHeaderLine,
  encodeChatHeaderLine,
  loadChatIndexBefore,
  loadChatIndexTail,
  nodeChatIndexCacheFsDeps,
  readChatJsonl,
  readPinsJsonl,
  sha256Hex,
  updateChatIndex,
} from "store/jsonl";
import type { ChatIndexCanonicalSource, ChatIndexDeps, ChatIndexStateStore } from "store/jsonl";
import {
  createLeaseStore,
  leaseNonce,
  systemLeaseIdentity,
  windowsLeaseLockApi,
} from "store/lease";
import type { LeaseStore } from "store/lease";
import {
  createBackupStore,
  migrationRegistry as defaultMigrationRegistry,
  nodeBackupStoreDeps,
} from "store/migration";
import type { BackupStore, DataFormatTooNewError } from "store/migration";
import {
  createDiagnosticsStore,
  createPageMetaCache,
  createRenderCache,
  nodeDiagnosticsStoreFsDeps,
  nodePageMetaCacheFsDeps,
  nodeRenderCacheFsDeps,
} from "store/projections";
import {
  FsAccessError,
  createSafeProjectFs,
  isNotFound,
  nodeSafeFsDeps,
  openManagedRoot,
} from "store/safe-fs";
import type { SafeFsError, SafeProjectFs, SafeProjectFsDeps } from "store/safe-fs";
import { createStagingStore, nodeStagingFsDeps } from "store/sandbox";
import type { StagingStore } from "store/sandbox";
import {
  PROJECT_GITIGNORE_FILENAME,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  WORKSPACE_STATE_FILENAME,
  WORKSPACE_STATE_FORMAT_VERSION,
  decodeProjectManifest,
  defaultWorkspaceLocalState,
  encodeProjectManifest,
  encodeWorkspaceLocalState,
  loadWorkspaceLocalState,
  parseToml,
  readFormatVersion,
  renderProjectGitignore,
} from "store/toml";
import type { ProjectManifest } from "store/toml";
import {
  admitTurn,
  buildManifestOperation,
  buildPinEventOperations,
  buildWorkspaceLocalPatchOperation,
  canonicalPagePath,
  chatJsonlPath,
  createWriteMutex,
  ensureJournalFormat,
  finalizeTurn,
  nodeRecoveryFsDeps,
  nodeTransactionFsDeps,
  observeFileImage,
  pageCommentsPath,
  readJournalFormat,
  recoverTransactions,
  runProjectMutation,
  terminalizeTurn,
} from "store/transaction";
import type {
  CommittedMarker,
  ProjectWritePermit,
  RecoveryFsDeps,
  TransactionFsDeps,
  TransactionOperation,
  TransactionWrapperDeps,
  WriteMutex,
} from "store/transaction";
import { createTrustStore, nodeTrustFsDeps } from "store/trust";
import type { TrustStore } from "store/trust";

import type {
  AbsPath,
  AdvanceSessionCheckpointInput,
  AppendPinEventInput,
  ChatHandle,
  ChatStore,
  CreateChatInput,
  CreateProjectInput,
  ManifestStore,
  OpenProject,
  OrphanTurnOutcome,
  PageStore,
  PinStore,
  ProjectionStore,
  RemovePageInput,
  RenamePageTitleInput,
  ReorderPagesInput,
  SetActiveChatInput,
  SetActivePageInput,
  SetWorkspaceLocalInput,
  Store,
  StoreDeps,
  TransactionEngine,
  TxOutcome,
  WorkspaceStateStore,
} from "../types";

// `store/model/factory.ts` — the composition-root entry point (T19). Wires every already-
// landed submodule against ONE injected `StoreDeps` bundle into the flat `Store` port
// (`../types.ts`), and implements the two sequences storage-identity §14.1/§14.2 name:
// existing-project launch (lease -> durability adapter + SafeProjectFs -> journal format ->
// recover transactions -> migrations -> schemas -> orphan turn scan -> load stores -> open)
// and new-project creation (one project-mutation transaction mints the format-1 layout, then
// the implicit trust grant is recorded).

// ---- errors ------------------------------------------------------------------------

/** A chat or comments JSONL could not be opened as a store handle — missing header, mid-file corruption, or an unreadable chat-index projection. */
export class JsonlOpenError extends errore.createTaggedError({
  name: "JsonlOpenError",
  message: "$kind $id could not be opened: $reason",
}) {}

/** `.termcraft/` (or a file inside it this factory expects) is missing, unreadable, or otherwise not a usable project layout. */
export class ProjectLayoutError extends errore.createTaggedError({
  name: "ProjectLayoutError",
  message: "project layout at $root is unusable: $reason",
}) {}

/** `createProject` was asked to create a project at a root that already has a `.termcraft/` directory (create-new semantics, storage-identity §4/§9). */
export class ProjectAlreadyExistsError extends errore.createTaggedError({
  name: "ProjectAlreadyExistsError",
  message: "a project already exists at $root",
}) {}

// ---- production dependency wiring --------------------------------------------------

/**
 * The real Node/Bun/Windows bindings for every `StoreDeps` boundary: `infrastructure/
 * durability`'s durable install + directory flush, `infrastructure/fs-guard`'s reparse
 * check + filesystem identity, `infrastructure/uuid`'s UUIDv7 minter, the system clock,
 * and the Windows OS-lock primitive `store/lease` needs. Tests construct `StoreDeps`
 * directly instead, substituting a crash-injecting `durableWrite`/`onBoundary` or fakes.
 */
export function nodeStoreDeps(input: { readonly userStateRoot: AbsPath }): StoreDeps {
  return {
    userStateRoot: input.userStateRoot,
    clock: systemClock,
    uuidv7,
    durableWrite: durableFileWrite,
    flushDir,
    lock: windowsLeaseLockApi,
    isReparsePoint,
    fsIdentity: formatFsIdentity,
  };
}

/** Adapts a landed `store/transaction` wrapper result into the plan's `TxOutcome` shape (`store/types.ts` divergence note 2) — for a caller (e.g. the phase-6 `core/ports/` lift) that wants the boolean-tagged shape instead of the plain errore union `TransactionEngine` itself returns. */
export function toTxOutcome(result: Error | CommittedMarker): TxOutcome {
  if (result instanceof Error) return { ok: false, error: result };
  return { ok: true, committed: result };
}

// ---- shared small helpers -----------------------------------------------------------

function resolveSafeFsDeps(deps: StoreDeps): SafeProjectFsDeps {
  if (deps.safeFsDeps !== undefined) return deps.safeFsDeps;
  return { ...nodeSafeFsDeps(), isReparsePoint: deps.isReparsePoint };
}

function openProjectSafeFs(
  termcraftDir: AbsPath,
  safeFsDeps: SafeProjectFsDeps,
): SafeFsError | SafeProjectFs {
  const root = openManagedRoot({ kind: "project", path: termcraftDir, deps: safeFsDeps });
  if (root instanceof Error) return root;
  return createSafeProjectFs(root, safeFsDeps);
}

/** Wraps `store/transaction`'s real Node bindings, substituting the injected `durableWrite`/`flushDir`/`onBoundary` — the seam the crash-injection sweep drives. */
function buildTransactionFsDeps(safeFs: SafeProjectFs, deps: StoreDeps): TransactionFsDeps {
  const base = nodeTransactionFsDeps(safeFs);
  return {
    ...base,
    durableWrite: deps.durableWrite,
    flushDir: deps.flushDir,
    onBoundary: deps.onBoundary,
  };
}

function buildRecoveryFsDeps(safeFs: SafeProjectFs, deps: StoreDeps): RecoveryFsDeps {
  const base = nodeRecoveryFsDeps(safeFs);
  return {
    ...base,
    durableWrite: deps.durableWrite,
    flushDir: deps.flushDir,
    onBoundary: deps.onBoundary,
  };
}

function makeLeaseStore(deps: StoreDeps): LeaseStore {
  return createLeaseStore({
    lock: deps.lock,
    identity: systemLeaseIdentity(deps.clock),
    mintNonce: leaseNonce,
  });
}

/** Acquire a permit, run `fn`, and always release — every `TransactionEngine` call and the one-shot recovery scan share this so a caller never sees `WriteMutex`/`ProjectWritePermit`. */
async function withPermit<T>(
  mutex: WriteMutex,
  fn: (permit: ProjectWritePermit) => Promise<T>,
): Promise<T> {
  const permit = await mutex.acquire();
  try {
    return await fn(permit);
  } finally {
    mutex.release(permit);
  }
}

// ---- transaction engine (turn-durability §4) -----------------------------------------

/** `payload` from a builder's optional `[payloadId, bytes]` tuple, as the `Map` every `runProjectMutation` call needs. */
function payloadMapOf(payload?: readonly [string, Uint8Array]): Map<string, Uint8Array> {
  return payload === undefined ? new Map() : new Map([payload]);
}

/**
 * `mutex` is created ONCE by the caller (`openProject`/`createProject`) and threaded in
 * here rather than created internally, so the SAME instance can also be exposed as
 * `OpenProject.writeMutex` (blocker B2) — every method below acquires/releases against it,
 * and so does a caller holding `writeMutex` directly; there is exactly one exclusion
 * primitive for this open project, never two.
 */
function makeTransactionEngine(
  mutex: WriteMutex,
  fs: TransactionFsDeps,
  deps: StoreDeps,
): TransactionEngine {
  const wrapperDeps: TransactionWrapperDeps = { fs, append: { newPayloadId: deps.uuidv7 } };

  const engine: TransactionEngine = {
    async runProjectMutation(input) {
      return withPermit(mutex, (permit) =>
        runProjectMutation(wrapperDeps, { ...input, mutex, permit }),
      );
    },
    async admitTurn(input) {
      return withPermit(mutex, (permit) => admitTurn(wrapperDeps, { ...input, mutex, permit }));
    },
    async finalizeTurn(input) {
      return withPermit(mutex, (permit) => finalizeTurn(wrapperDeps, { ...input, mutex, permit }));
    },
    async terminalizeTurn(input) {
      return withPermit(mutex, (permit) =>
        terminalizeTurn(wrapperDeps, { ...input, mutex, permit }),
      );
    },
    async recover() {
      const recoveryFsDeps = buildRecoveryFsDeps(fs.safeFs, deps);
      return withPermit(mutex, (permit) => recoverTransactions(recoveryFsDeps, mutex, permit));
    },

    // ---- named domain methods (phase-6 blocker B3) -----------------------------------
    // `core` never learns `TransactionOperation`'s shape: each method below builds its own
    // operation(s) from the already-landed builders (`observeFileImage`,
    // `buildManifestOperation`, `buildWorkspaceLocalPatchOperation`,
    // `buildStandalonePinEventOperation`) and runs them through the same `runProjectMutation`
    // base engine every other project mutation already uses.

    async createChat(input: CreateChatInput) {
      return withPermit(mutex, async (permit) => {
        const header: ChatHeader = {
          kind: "chat",
          formatVersion: 1,
          projectId: input.projectId,
          chatId: input.chatId,
          createdAt: input.createdAt,
        };
        const headerLine = encodeChatHeaderLine(header);
        if (headerLine instanceof Error) return headerLine;

        const payloadId = deps.uuidv7();
        const operation: TransactionOperation = {
          index: 0,
          target: chatJsonlPath(input.chatId),
          mode: "replace",
          oldImage: { state: "absent" }, // create-new: an existing header at this chatId surfaces as the engine's ordinary CAS conflict, never a silent overwrite
          newImage: { state: "file", sha256: sha256Hex(headerLine), size: headerLine.byteLength },
          payloadId,
        };
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "chat-creation",
          operations: [operation],
          payloads: new Map([[payloadId, headerLine]]),
          createdAt: input.createdAt,
        });
      });
    },

    async setActiveChat(input: SetActiveChatInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildWorkspaceLocalPatchOperation(wrapperDeps, (current) => ({
          ...current,
          activeChatId: input.activeChatId,
        }));
        if (built instanceof Error) return built;
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "local-state-write",
          operations: [built.operation],
          payloads: payloadMapOf(built.payload),
          createdAt: input.createdAt,
        });
      });
    },

    async setActivePage(input: SetActivePageInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildWorkspaceLocalPatchOperation(wrapperDeps, (current) => ({
          ...current,
          activePageSlug: input.activePageSlug,
        }));
        if (built instanceof Error) return built;
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "local-state-write",
          operations: [built.operation],
          payloads: payloadMapOf(built.payload),
          createdAt: input.createdAt,
        });
      });
    },

    async renamePageTitle(input: RenamePageTitleInput) {
      return withPermit(mutex, async (permit) => {
        const target = canonicalPagePath(input.pageSlug);
        const oldImage = observeFileImage(fs, target);
        if (oldImage instanceof Error) return oldImage;

        const payloadId = deps.uuidv7();
        const operation: TransactionOperation = {
          index: 0,
          target,
          mode: "replace",
          oldImage,
          newImage: {
            state: "file",
            sha256: sha256Hex(input.newBytes),
            size: input.newBytes.byteLength,
          },
          payloadId,
        };
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "title-edit",
          operations: [operation],
          payloads: new Map([[payloadId, input.newBytes]]),
          createdAt: input.createdAt,
        });
      });
    },

    async reorderPages(input: ReorderPagesInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildManifestOperation(wrapperDeps, input.manifestBefore, input.orderedSlugs);
        if (built instanceof Error) return built;
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "page-reorder",
          // `built === null` when the requested order already matches the durable manifest —
          // a legal, deterministic no-op transaction rather than a special-cased early return.
          operations: built === null ? [] : [{ ...built.operation, index: 0 }],
          payloads: built === null ? new Map() : payloadMapOf(built.payload),
          createdAt: input.createdAt,
        });
      });
    },

    async removePage(input: RemovePageInput) {
      return withPermit(mutex, async (permit) => {
        const remainingSlugs = input.manifestBefore.pages.filter((slug) => slug !== input.pageSlug);
        const manifestOp = buildManifestOperation(
          wrapperDeps,
          input.manifestBefore,
          remainingSlugs,
        );
        if (manifestOp instanceof Error) return manifestOp;

        const canonicalTarget = canonicalPagePath(input.pageSlug);
        const canonicalOldImage = observeFileImage(fs, canonicalTarget);
        if (canonicalOldImage instanceof Error) return canonicalOldImage;

        const commentsTarget = pageCommentsPath(input.pageSlug);
        const commentsOldImage = observeFileImage(fs, commentsTarget);
        if (commentsOldImage instanceof Error) return commentsOldImage;

        const operations: TransactionOperation[] = [];
        const payloads = new Map<string, Uint8Array>();
        if (manifestOp !== null) {
          operations.push({ ...manifestOp.operation, index: operations.length });
          if (manifestOp.payload !== undefined)
            payloads.set(manifestOp.payload[0], manifestOp.payload[1]);
        }
        // Deleting an already-absent target is a documented no-op at apply time (`engine.ts`'s
        // `applyFixedOperation`: current already matches newImage=absent) — so both deletes are
        // always included, whether or not this page's canonical source/comments log exist.
        operations.push({
          index: operations.length,
          target: canonicalTarget,
          mode: "delete",
          oldImage: canonicalOldImage,
          newImage: { state: "absent" },
        });
        operations.push({
          index: operations.length,
          target: commentsTarget,
          mode: "delete",
          oldImage: commentsOldImage,
          newImage: { state: "absent" },
        });

        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "page-remove",
          operations,
          payloads,
          createdAt: input.createdAt,
        });
      });
    },

    async appendPinEvent(input: AppendPinEventInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildPinEventOperations(wrapperDeps, {
          pageSlug: input.pageSlug,
          projectId: input.projectId,
          event: input.event,
        });
        if (built instanceof Error) return built;
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "pin-event",
          operations: built.operations,
          payloads: built.payloads,
          createdAt: input.createdAt,
        });
      });
    },

    async setWorkspaceLocal(input: SetWorkspaceLocalInput) {
      return withPermit(mutex, async (permit) => {
        const built = buildWorkspaceLocalPatchOperation(wrapperDeps, (current) => ({
          ...current,
          ...input.patch,
        }));
        if (built instanceof Error) return built;
        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "local-state-write",
          operations: [built.operation],
          payloads: payloadMapOf(built.payload),
          createdAt: input.createdAt,
        });
      });
    },

    async advanceSessionCheckpoint(input: AdvanceSessionCheckpointInput) {
      return withPermit(mutex, async (permit) => {
        const chatBytes = fs.safeFs.readFile(chatJsonlPath(input.chatId));
        if (chatBytes instanceof Error) return chatBytes;

        const checkpoint = computeAdvancedSessionCheckpoint({
          chatId: input.chatId,
          sessionScopeId: input.sessionScopeId,
          sessionId: input.sessionId,
          recordCount: input.recordCount,
          chunks: [chatBytes],
        });
        if (checkpoint instanceof Error) return checkpoint;

        const built = buildWorkspaceLocalPatchOperation(wrapperDeps, (current) => ({
          ...current,
          // One checkpoint per (chatId, sessionScopeId) — replace the matching entry if one
          // already exists, otherwise append (storage-identity §6.2).
          sessionCheckpoints: [
            ...current.sessionCheckpoints.filter(
              (entry) =>
                entry.chatId !== checkpoint.chatId ||
                entry.sessionScopeId !== checkpoint.sessionScopeId,
            ),
            checkpoint,
          ],
        }));
        if (built instanceof Error) return built;

        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "local-state-write",
          operations: [built.operation],
          payloads: payloadMapOf(built.payload),
          createdAt: input.createdAt,
        });
      });
    },
  };
  return engine;
}

// ---- manifest + workspace state --------------------------------------------------------

function makeManifestStore(safeFs: SafeProjectFs): ManifestStore {
  return {
    async read() {
      const bytes = safeFs.readFile(PROJECT_MANIFEST_FILENAME);
      if (bytes instanceof Error) return bytes;
      return decodeProjectManifest(new TextDecoder().decode(bytes));
    },
  };
}

function makeWorkspaceStateStore(safeFs: SafeProjectFs): WorkspaceStateStore {
  return {
    async read() {
      const bytes = safeFs.readFile(WORKSPACE_STATE_FILENAME);
      if (bytes instanceof Error) {
        if (bytes instanceof FsAccessError && isNotFound(bytes))
          return loadWorkspaceLocalState({ text: null });
        return bytes;
      }
      return loadWorkspaceLocalState({ text: new TextDecoder().decode(bytes) });
    },
  };
}

// ---- pages + pins -----------------------------------------------------------------------

function makePageStore(safeFs: SafeProjectFs, manifest: ManifestStore): PageStore {
  return {
    async readSource(pageSlug) {
      const bytes = safeFs.readFile(canonicalPagePath(pageSlug));
      if (bytes instanceof Error) return bytes;
      return { bytes, sourceHash: sha256Hex(bytes) };
    },
    async listSlugs() {
      const read = await manifest.read();
      if (read instanceof Error) return read;
      return read.pages;
    },
  };
}

/**
 * storage-identity §5.2: "A comments header's `projectId` and `pageSlug` must equal its
 * containing project and directory. Mismatch is corruption; readers do not repair identity by
 * renaming files or rewriting headers." A file with no readable header at all cannot carry a
 * matching identity either, so it is rejected the same way (major finding #2).
 */
function makePinStore(safeFs: SafeProjectFs, projectId: string): PinStore {
  return {
    async fold(pageSlug) {
      const relPath = pageCommentsPath(pageSlug);
      const bytes = safeFs.readFile(relPath);
      if (bytes instanceof Error) {
        if (bytes instanceof FsAccessError && isNotFound(bytes)) return [];
        return bytes;
      }
      const doc = readPinsJsonl({ path: relPath, chunks: [bytes] });
      if (doc instanceof Error)
        return new JsonlOpenError({ kind: "pins", id: pageSlug, reason: doc.message, cause: doc });
      if (doc.header === null)
        return new JsonlOpenError({
          kind: "pins",
          id: pageSlug,
          reason: "missing or invalid comments header",
        });
      if (doc.header.projectId !== projectId) {
        return new JsonlOpenError({
          kind: "pins",
          id: pageSlug,
          reason: `comments header names projectId ${doc.header.projectId}, which does not match this project`,
        });
      }
      if (doc.header.pageSlug !== pageSlug) {
        return new JsonlOpenError({
          kind: "pins",
          id: pageSlug,
          reason: `comments header names pageSlug ${doc.header.pageSlug}, which does not match its containing directory`,
        });
      }
      const folded = foldPins(doc.records);
      if (folded instanceof Error)
        return new JsonlOpenError({
          kind: "pins",
          id: pageSlug,
          reason: folded.message,
          cause: folded,
        });
      return folded;
    },
  };
}

// ---- chats (storage-identity §11, projections §7) ----------------------------------------

/**
 * The chat index's persisted local cache (projections §7.1: "the on-disk index grows
 * linearly with record count; resident index memory does not"). Lives under
 * `cache/chat-index/` — a raw-fs local cache root, exactly like `store/projections`'s
 * `page-meta-cache.ts`/`diagnostics-store.ts`/`render-cache.ts` (never portable, never
 * routed through `SafeProjectFs`'s managed namespace grammar). Before this fix (major
 * finding #3) NO implementation of `ChatIndexPageStore` ever wrote to disk at all — every
 * `ChatStore.open` call built a fresh in-memory index from a full-file read, discarded the
 * instant the call returned.
 */
function makeChatIndexCache(
  safeFs: SafeProjectFs,
  deps: StoreDeps,
): { readonly pages: ChatIndexDeps["pages"]; readonly state: ChatIndexStateStore } {
  const root = path.join(safeFs.root.realPath, "cache", "chat-index");
  const cacheFsDeps = nodeChatIndexCacheFsDeps(deps.durableWrite);
  return {
    pages: createNodeChatIndexPageStore(root, cacheFsDeps),
    state: createNodeChatIndexStateStore(root, cacheFsDeps),
  };
}

/** projections §16.1: "Chat scan buffer: 1 MiB plus one canonical bounded record line." */
const CHAT_INDEX_SCAN_CHUNK_BYTES = JSONL_MAX_PHYSICAL_LINE_BYTES;

/**
 * Bridges `SafeProjectFs`'s bounded `readRange` to `ChatIndexCanonicalSource`: `openChunks()`
 * streams the canonical file in ≤1 MiB chunks — never materializing the whole file at once —
 * for the rare COLD-BUILD path (`buildChatIndex`, reachable only the first time a chat is
 * ever indexed; every later open takes `updateChatIndex`'s bounded-suffix path below, which
 * never calls `openChunks()` at all). `openChunks()`'s `Iterable<Uint8Array>` contract has no
 * way to surface a failed chunk as a value, so a mid-stream disk failure THROWS — the ONE
 * boundary in this factory where `.catch()` on the awaited `buildChatIndex`/`updateChatIndex`
 * call (below) is the errore adapter, matching the "only at the lowest call stack level
 * touching an uncontrolled primitive" boundary rule.
 */
function diskChatIndexSource(
  safeFs: SafeProjectFs,
  relPath: string,
  totalBytes: number,
): ChatIndexCanonicalSource {
  function* chunks(): Generator<Uint8Array> {
    let offset = 0;
    while (offset < totalBytes) {
      const end = Math.min(offset + CHAT_INDEX_SCAN_CHUNK_BYTES, totalBytes);
      const bytes = safeFs.readRange(relPath, offset, end);
      if (bytes instanceof Error)
        throw new Error(`chat scan chunk read failed at offset ${offset}`, { cause: bytes });
      yield bytes;
      offset = end;
    }
  }
  return {
    openChunks: () => chunks(),
    async readRange({ start, end }) {
      return safeFs.readRange(relPath, start, end);
    },
  };
}

/** A bounded read of just the first physical line (≤1 MiB), decoded as the chat header — never a whole-file read merely to answer "what chat/project does this file claim to be" (projections §16.1). */
function readChatHeaderBounded(
  safeFs: SafeProjectFs,
  relPath: string,
  totalBytes: number,
): SafeFsError | Error | ChatHeader | null {
  const bound = Math.min(totalBytes, JSONL_MAX_PHYSICAL_LINE_BYTES);
  if (bound === 0) return null;
  const prefix = safeFs.readRange(relPath, 0, bound);
  if (prefix instanceof Error) return prefix;
  const lf = prefix.indexOf(JSONL_LF);
  if (lf === -1) return null;
  const decoded = decodeChatHeaderLine(prefix.subarray(0, lf + 1));
  return decoded instanceof Error ? null : decoded;
}

/**
 * storage-identity §5.2: "The chat filename must equal the `chatId` in its header. A chat
 * header's `projectId` must equal `project.toml`. Mismatch is corruption; readers do not
 * repair identity by renaming files or rewriting headers." Checked here, at the one place a
 * chat is opened, before any orphan-turn scan or handle is ever produced from it (blocker
 * finding #2 — a misplaced or duplicated chat log was previously treated as fully valid).
 *
 * The chat index itself is persisted (major finding #3): the FIRST open of a given chat
 * (no cached state yet) streams a bounded cold build; every later open re-hydrates the
 * cached state and takes `updateChatIndex`'s bounded-suffix fast path — bounded resident
 * pages, bounded scan buffer, and index memory that no longer regrows to O(record count) on
 * every single open, matching projections §7.1/§16.1/§16.3.
 */
function makeChatStore(safeFs: SafeProjectFs, deps: StoreDeps, projectId: string): ChatStore {
  const cache = makeChatIndexCache(safeFs, deps);

  return {
    async open(chatId) {
      const relPath = chatJsonlPath(chatId);
      const stat = safeFs.stat(relPath);
      if (stat instanceof Error) return stat;

      const header = readChatHeaderBounded(safeFs, relPath, stat.size);
      if (header instanceof Error)
        return new JsonlOpenError({
          kind: "chat",
          id: chatId,
          reason: "chat header unreadable",
          cause: header,
        });
      if (header === null)
        return new JsonlOpenError({
          kind: "chat",
          id: chatId,
          reason: "missing or invalid chat header",
        });
      if (header.chatId !== chatId) {
        return new JsonlOpenError({
          kind: "chat",
          id: chatId,
          reason: `chat header names chatId ${header.chatId}, which does not match its filename`,
        });
      }
      if (header.projectId !== projectId) {
        return new JsonlOpenError({
          kind: "chat",
          id: chatId,
          reason: `chat header names projectId ${header.projectId}, which does not match this project`,
        });
      }

      const absPath = safeFs.resolve(relPath);
      if (absPath instanceof Error) return absPath;
      const identity = deps.fsIdentity(absPath);
      if (identity instanceof Error)
        return new JsonlOpenError({
          kind: "chat",
          id: chatId,
          reason: "filesystem identity unreadable",
          cause: identity,
        });

      const source = diskChatIndexSource(safeFs, relPath, stat.size);
      const chatIndexDeps: ChatIndexDeps = { pages: cache.pages };

      const previous = await cache.state.read(chatId);
      const built = await (
        previous === null
          ? buildChatIndex({
              chatId,
              canonicalIdentity: identity,
              projectViewGeneration: "1",
              source,
              deps: chatIndexDeps,
            })
          : updateChatIndex(previous, {
              canonicalIdentity: identity,
              projectViewGeneration: "1",
              totalBytes: stat.size,
              source,
              deps: chatIndexDeps,
            })
      ).catch(
        (cause) =>
          new JsonlOpenError({
            kind: "chat",
            id: chatId,
            reason: "chat index scan failed while streaming from disk",
            cause,
          }),
      );
      if (built instanceof Error)
        return JsonlOpenError.is(built)
          ? built
          : new JsonlOpenError({ kind: "chat", id: chatId, reason: built.message, cause: built });
      const state = built;

      // Never blocks opening on a failed CACHE write — the in-memory `state` above is
      // already valid for this call; a failed persist just costs a slower rebuild on the
      // next open (the same "corrupt/missing local cache = rebuild, never an open-blocking
      // error" policy every other projection in this codebase already follows).
      const persisted = await cache.state.write(chatId, state);
      if (persisted instanceof Error)
        console.warn(`store: chat index cache persist failed for ${chatId}:`, persisted.message);

      const handle: ChatHandle = {
        header,
        async loadTail(limit, byteBudget) {
          return loadChatIndexTail(state, chatIndexDeps, source, { limit, byteBudget });
        },
        async loadBefore(cursor, limit, byteBudget) {
          return loadChatIndexBefore(state, chatIndexDeps, source, cursor, { limit, byteBudget });
        },
      };
      return handle;
    },
  };
}

// ---- orphan turn scan (turn-durability §7.7) -----------------------------------------

/**
 * Every chat's user records without a matching terminal record get exactly one
 * `system:error` (`outcome: "interrupted"`) terminalization — the store-level half of the
 * §7.7 sweep. WHICH chat/turnId pairs to scan is decided here (this factory owns every
 * chat under the project); `terminalizeTurn`'s own idempotency guards
 * (`TurnAlreadyTerminalError`/`TurnRecordNotFoundError`) are what make re-running this scan
 * on every launch safe. A chat with a non-`clean` tail is skipped — an unresolved corrupt
 * suffix waits for explicit repair, never an automatic terminalization.
 *
 * DIVERGENCE (documented, not silent — CLAUDE.md): this still reads each chat's WHOLE file
 * (bounded only by the 64 MiB `chat-jsonl` namespace cap), unlike `makeChatStore.open`'s now-
 * bounded/persisted chat index (major finding #3's primary fix). `ChatIndexEntry` does not
 * record a record's `kind` (only `recordId`/`turnId`/`ts`/`changedPages`), so the index alone
 * cannot distinguish a `user` record from its terminal counterpart without a real per-record
 * projection this phase does not define. Reusing the index for orphan detection would be a
 * new capability, not a bounded-read of an existing one — left for a future task rather than
 * risking a mis-scoped rewrite of this durability-sensitive sweep under this fix.
 */
async function scanOrphanTurns(input: {
  readonly safeFs: SafeProjectFs;
  readonly engine: TransactionEngine;
  readonly deps: StoreDeps;
  readonly projectId: string;
}): Promise<readonly OrphanTurnOutcome[]> {
  const names = input.safeFs.list("chats");
  if (names instanceof Error) {
    if (names instanceof FsAccessError && isNotFound(names)) return [];
    console.warn("store: orphan turn scan could not list chats:", names.message);
    return [];
  }

  const outcomes: OrphanTurnOutcome[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const chatId = name.slice(0, -".jsonl".length);
    const relPath = chatJsonlPath(chatId);
    const bytes = input.safeFs.readFile(relPath);
    if (bytes instanceof Error) {
      console.warn(`store: orphan turn scan could not read ${relPath}:`, bytes.message);
      continue;
    }
    const doc = readChatJsonl({ path: relPath, chunks: [bytes] });
    if (doc instanceof Error) {
      console.warn(
        `store: orphan turn scan skipping ${relPath}, mid-file corruption:`,
        doc.message,
      );
      continue;
    }
    // storage-identity §5.2 identity check (blocker finding #2), re-applied here rather than
    // relying on a caller to have gone through `ChatStore.open` first: this scan reads chat
    // bytes directly and durably APPENDS a terminalization record, so a misplaced/duplicated
    // chat log must be refused BEFORE any write, exactly like `makeChatStore.open` refuses to
    // hand out a mismatched handle. Never repaired automatically — only skipped.
    if (
      doc.header === null ||
      doc.header.chatId !== chatId ||
      doc.header.projectId !== input.projectId
    ) {
      console.warn(`store: orphan turn scan skipping ${relPath}, chat header identity mismatch`);
      continue;
    }
    if (doc.tail.kind !== "clean") continue;

    const terminalTurnIds = new Set<string>();
    for (const record of doc.records) {
      if (
        record.kind !== "agent" &&
        record.kind !== "system:error" &&
        record.kind !== "system:cancelled"
      )
        continue;
      if (record.turnId !== undefined) terminalTurnIds.add(record.turnId);
    }
    const orphanTurnIds = new Set<string>();
    for (const record of doc.records) {
      if (record.kind === "user" && !terminalTurnIds.has(record.turnId))
        orphanTurnIds.add(record.turnId);
    }

    for (const turnId of orphanTurnIds) {
      const createdAt = input.deps.clock.now().toISOString();
      const record: ChatSystemErrorRecord = {
        kind: "system:error",
        recordId: input.deps.uuidv7(),
        turnId,
        outcome: "interrupted",
        reason: "process_restart_before_intent",
        text: "termcraft restarted before this turn finished.",
        ts: createdAt,
      };
      const result = await input.engine.terminalizeTurn({
        transactionId: input.deps.uuidv7(),
        turnId,
        targetChatId: chatId,
        record,
        createdAt,
      });
      if (result instanceof Error)
        console.warn(
          `store: orphan turn scan could not terminalize turn ${turnId} in chat ${chatId}:`,
          result.message,
        );
      outcomes.push({ chatId, turnId, terminalized: !(result instanceof Error) });
    }
  }
  return outcomes;
}

// ---- migrations gate (storage-identity §12) --------------------------------------------

/**
 * Peek `format_version` off `project.toml`/`workspace.local.toml` WITHOUT the full field
 * schema and gate it through the (currently empty) live migration registry, before the
 * schemas step decodes either file in full — mirrors the ordering the launch sequence
 * names ("migrations -> schemas"). A malformed or missing file is left for the schemas
 * step to report; this gate only ever returns a hard `DataFormatTooNewError`.
 */
function migrationsGate(safeFs: SafeProjectFs): SafeFsError | DataFormatTooNewError | null {
  const checks: ReadonlyArray<{ readonly file: string; readonly supported: number }> = [
    { file: PROJECT_MANIFEST_FILENAME, supported: PROJECT_MANIFEST_FORMAT_VERSION },
    { file: WORKSPACE_STATE_FILENAME, supported: WORKSPACE_STATE_FORMAT_VERSION },
  ];
  for (const check of checks) {
    const bytes = safeFs.readFile(check.file);
    if (bytes instanceof Error) {
      if (bytes instanceof FsAccessError && isNotFound(bytes)) continue;
      return bytes;
    }
    // `Bun.TOML.parse` throws a Bun `BuildMessage`, which is NOT an `Error` instance —
    // `errore.try` would rethrow it rather than hand it to a `catch` mapper (verified against
    // the pinned Bun runtime). `parseToml` (`store/toml`) already normalizes that foreign
    // throwable into a value; reusing it here instead of a local `errore.try` reimplementation
    // is what keeps this gate from ever escaping as an uncaught throw (blocker #7).
    const parsed = parseToml(new TextDecoder().decode(bytes));
    if (parsed instanceof Error) continue; // malformed TOML is the schemas step's problem, not this gate's
    const found = readFormatVersion(parsed.value);
    if (found === null) continue;
    const tooNew = defaultMigrationRegistry.checkNotTooNew({
      file: check.file,
      field: "format_version",
      found,
      supported: check.supported,
    });
    if (tooNew instanceof Error) return tooNew;
  }
  return null;
}

// ---- projections / trust / staging / backups (composed facades) -------------------------

function makeProjectionStore(safeFs: SafeProjectFs, deps: StoreDeps): ProjectionStore {
  const pageMetaCache = createPageMetaCache({
    root: path.join(safeFs.root.realPath, "cache", "page-meta"),
    fs: { ...nodePageMetaCacheFsDeps, durableWrite: deps.durableWrite },
    clock: deps.clock,
  });
  const diagnosticsStore = createDiagnosticsStore({
    root: path.join(safeFs.root.realPath, "diagnostics"),
    fs: { ...nodeDiagnosticsStoreFsDeps, durableWrite: deps.durableWrite },
    clock: deps.clock,
  });
  const renderCache = createRenderCache({
    root: path.join(safeFs.root.realPath, "cache", "export-render"),
    fs: { ...nodeRenderCacheFsDeps, durableWrite: deps.durableWrite },
    clock: deps.clock,
  });
  return {
    pageMetaGet: (key) => pageMetaCache.get(key),
    pageMetaPut: (entry) => pageMetaCache.put(entry),
    diagnosticsGet: (key) => diagnosticsStore.get(key),
    diagnosticsPut: (entry) => diagnosticsStore.put(entry),
    renderGet: (key) => renderCache.get(key),
    renderPut: (entry) => renderCache.put(entry),
  };
}

function makeTrustStore(deps: StoreDeps): TrustStore {
  return createTrustStore({
    userStateRoot: deps.userStateRoot,
    clock: deps.clock,
    fs: { ...nodeTrustFsDeps, fsIdentity: deps.fsIdentity, durableWrite: deps.durableWrite },
  });
}

function makeStagingStore(deps: StoreDeps): StagingStore {
  return createStagingStore({
    userStateRoot: deps.userStateRoot,
    clock: deps.clock,
    fs: nodeStagingFsDeps(),
    durableWrite: deps.durableWrite,
  });
}

function makeBackupStore(deps: StoreDeps): BackupStore {
  return createBackupStore(nodeBackupStoreDeps(deps.userStateRoot, deps.clock));
}

// ---- assembling the open handle -----------------------------------------------------

function assembleOpenProject(input: {
  readonly root: AbsPath;
  readonly safeFs: SafeProjectFs;
  readonly lease: OpenProject["lease"];
  readonly deps: StoreDeps;
  readonly recovery: OpenProject["recovery"];
  readonly orphanTurns: readonly OrphanTurnOutcome[];
  readonly engine: TransactionEngine;
  /** The SAME `WriteMutex` `engine` acquires/releases against internally (blocker B2) — never a second instance. */
  readonly writeMutex: WriteMutex;
  readonly manifestStore: ManifestStore;
  readonly workspaceStateStore: WorkspaceStateStore;
  /** storage-identity §5.2 identity anchor: every chat/comments header opened under this project must name exactly this `projectId` (finding #2). */
  readonly projectId: string;
}): OpenProject {
  const {
    root,
    safeFs,
    lease,
    deps,
    recovery,
    orphanTurns,
    engine,
    writeMutex,
    manifestStore,
    workspaceStateStore,
    projectId,
  } = input;

  let closed = false;
  const project: OpenProject = {
    root,
    lease,
    safeFs,
    recovery,
    orphanTurns,
    transactions: engine,
    writeMutex,
    manifest: manifestStore,
    workspaceState: workspaceStateStore,
    chats: makeChatStore(safeFs, deps, projectId),
    pins: makePinStore(safeFs, projectId),
    pages: makePageStore(safeFs, manifestStore),
    trust: makeTrustStore(deps),
    projections: makeProjectionStore(safeFs, deps),
    staging: makeStagingStore(deps),
    backups: makeBackupStore(deps),
    migrations: defaultMigrationRegistry,
    async close() {
      if (closed) return;
      closed = true;
      await lease.release();
    },
  };
  return project;
}

// ---- existing-project launch (storage-identity §14.1 / turn-durability §12) --------------

async function openProject(deps: StoreDeps, root: AbsPath): Promise<Error | OpenProject> {
  const termcraftDir = path.join(root, ".termcraft");

  // 0. durability pre-flight (M5, storage-identity S4 / turn-durability S1/S13): refuse a
  // volume that cannot demonstrate durable writes BEFORE the lease acquire below performs the
  // first write. The probe targets `root` — the directory the caller pointed at, which is
  // guaranteed to exist here — rather than `termcraftDir`. A healthy volume whose `root` simply
  // isn't a project yet (no `.termcraft`) must fall through to the real "not a project" error
  // below, not get misreported as a durability failure: `flushDir` opens its target with
  // Win32 `OPEN_EXISTING`, so probing the maybe-absent `termcraftDir` would return
  // `DirectoryFlushError{lastError: ERROR_PATH_NOT_FOUND}` for a merely-missing directory,
  // indistinguishable from `lastError: ERROR_INVALID_FUNCTION` (the real no-write-through
  // signal). `root` is on the same volume as `termcraftDir` (its parent), so the durability
  // signal itself is unchanged.
  const durabilityError = probeDurability(root, { flush: deps.flushDir });
  if (durabilityError instanceof Error) return durabilityError;

  // 1. lease
  const lease = await makeLeaseStore(deps).acquire(root);
  if (lease instanceof Error) return lease;

  // 2. durability adapter + SafeProjectFs
  const safeFsDeps = resolveSafeFsDeps(deps);
  const safeFs = openProjectSafeFs(termcraftDir, safeFsDeps);
  if (safeFs instanceof Error) {
    await lease.release();
    return safeFs;
  }
  const engineFsDeps = buildTransactionFsDeps(safeFs, deps);

  // 3. journal format (blocker finding #1: a genuinely newer `transactions.local/format.json`
  // must block the Workspace HERE, before recovery ever lists a transaction directory).
  const journalFormat = readJournalFormat({ safeFs });
  if (journalFormat instanceof Error) {
    await lease.release();
    return journalFormat;
  }

  // 4. recover transactions
  const recoveryFsDeps = buildRecoveryFsDeps(safeFs, deps);
  const recoveryMutex = createWriteMutex();
  const recovery = await withPermit(recoveryMutex, (permit) =>
    recoverTransactions(recoveryFsDeps, recoveryMutex, permit),
  );
  if (!recovery.ok) {
    await lease.release();
    return recovery.error;
  }

  // 5. migrations
  const tooNew = migrationsGate(safeFs);
  if (tooNew instanceof Error) {
    await lease.release();
    return tooNew;
  }

  // 6. schemas
  const manifestStore = makeManifestStore(safeFs);
  const manifestRead = await manifestStore.read();
  if (manifestRead instanceof Error) {
    await lease.release();
    return manifestRead;
  }
  const workspaceStateStore = makeWorkspaceStateStore(safeFs);
  const workspaceRead = await workspaceStateStore.read();
  if (workspaceRead instanceof Error) {
    await lease.release();
    return workspaceRead;
  }

  // 7. orphan turn scan
  const writeMutex = createWriteMutex();
  const engine = makeTransactionEngine(writeMutex, engineFsDeps, deps);
  const orphanTurns = await scanOrphanTurns({
    safeFs,
    engine,
    deps,
    projectId: manifestRead.projectId,
  });

  // 8. load stores + 9. open
  return assembleOpenProject({
    root,
    safeFs,
    lease,
    deps,
    recovery,
    orphanTurns,
    engine,
    writeMutex,
    manifestStore,
    workspaceStateStore,
    projectId: manifestRead.projectId,
  });
}

// ---- new-project creation (storage-identity §14.2) ---------------------------------------

function buildReplaceOperation(
  deps: StoreDeps,
  index: number,
  target: string,
  bytes: Uint8Array,
): { readonly operation: TransactionOperation; readonly payload: readonly [string, Uint8Array] } {
  const payloadId = deps.uuidv7();
  return {
    operation: {
      index,
      target,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    },
    payload: [payloadId, bytes],
  };
}

async function createProject(
  deps: StoreDeps,
  input: CreateProjectInput,
): Promise<Error | OpenProject> {
  const termcraftDir = path.join(input.root, ".termcraft");
  if (fs.existsSync(termcraftDir)) return new ProjectAlreadyExistsError({ root: input.root });

  // durability pre-flight (M5, storage-identity S4 / turn-durability S1/S13): refuse a volume
  // that cannot demonstrate durable writes BEFORE `mkdirSync` below performs the first mutation.
  // `.termcraft` does not exist yet, so the flush probe targets the already-existing parent
  // `input.root` instead — probing a directory the create-new step is about to make itself would
  // be a mutation on a volume this gate might still refuse.
  const durabilityError = probeDurability(input.root, { flush: deps.flushDir });
  if (durabilityError instanceof Error) return durabilityError;

  const created = errore.try({
    try: () => {
      fs.mkdirSync(termcraftDir, { recursive: true });
      return undefined;
    },
    catch: (cause) =>
      new ProjectLayoutError({ root: input.root, reason: "could not create .termcraft", cause }),
  });
  if (created instanceof Error) return created;

  const lease = await makeLeaseStore(deps).acquire(input.root);
  if (lease instanceof Error) return lease;

  const safeFsDeps = resolveSafeFsDeps(deps);
  const safeFs = openProjectSafeFs(termcraftDir, safeFsDeps);
  if (safeFs instanceof Error) {
    await lease.release();
    return safeFs;
  }

  // The journal-format gate's own record (blocker finding #1): create-new, once, so every
  // later `openProject` on this project can read it before recovery ever lists a transaction
  // directory. It lives outside any `TransactionOperation` — the plan schema itself refuses
  // any operation targeting `transactions.local/` (`./plan.ts`'s `targetsJournal` guard).
  const engineFsDeps = buildTransactionFsDeps(safeFs, deps);
  const journalFormatWritten = ensureJournalFormat(engineFsDeps);
  if (journalFormatWritten instanceof Error) {
    await lease.release();
    return journalFormatWritten;
  }

  const writeMutex = createWriteMutex();
  const engine = makeTransactionEngine(writeMutex, engineFsDeps, deps);

  const projectId = deps.uuidv7();
  const chatId = deps.uuidv7();
  const createdAt = deps.clock.now().toISOString();

  const manifest: ProjectManifest = {
    formatVersion: PROJECT_MANIFEST_FORMAT_VERSION,
    projectId,
    name: input.name,
    createdAt,
    targetStack: input.targetStack,
    pages: [],
  };
  const manifestBytes = new TextEncoder().encode(encodeProjectManifest(manifest));
  const gitignoreBytes = new TextEncoder().encode(renderProjectGitignore());
  // The freshly minted `chatId` below is ALSO this project's active chat. Writing the plain
  // `defaultWorkspaceLocalState()` here left `activeChatId` null while the chat header itself was
  // created two lines down, so a brand-new project had a chat on disk that nothing pointed at —
  // and `turn.start` refuses with "no active chat yet" (`core/kernel/model/handlers/turn.ts`)
  // before any agent runs. That refusal returns an empty event list, so the UI showed no message,
  // no spinner and no error: every first turn in a new project failed silently and permanently.
  // Set here rather than through a follow-up `setActiveChat` so the pointer lands in the SAME
  // project-creation transaction as the header it points at, never as a second write that could
  // be interrupted between the two.
  const workspaceBytes = new TextEncoder().encode(
    encodeWorkspaceLocalState({ ...defaultWorkspaceLocalState(), activeChatId: chatId }),
  );
  const chatHeader: ChatHeader = { kind: "chat", formatVersion: 1, projectId, chatId, createdAt };
  const chatHeaderLine = encodeChatHeaderLine(chatHeader);
  if (chatHeaderLine instanceof Error) {
    await lease.release();
    return chatHeaderLine;
  }

  const manifestOp = buildReplaceOperation(deps, 0, PROJECT_MANIFEST_FILENAME, manifestBytes);
  const gitignoreOp = buildReplaceOperation(deps, 1, PROJECT_GITIGNORE_FILENAME, gitignoreBytes);
  const workspaceOp = buildReplaceOperation(deps, 2, WORKSPACE_STATE_FILENAME, workspaceBytes);
  const chatOp = buildReplaceOperation(deps, 3, chatJsonlPath(chatId), chatHeaderLine);

  // ONE project-mutation transaction mints projectId + the format-1 layout + the generated
  // .gitignore + the workspace file + the first chat header (storage-identity §14.2).
  const result = await engine.runProjectMutation({
    transactionId: deps.uuidv7(),
    actionId: deps.uuidv7(),
    mutationKind: "project-creation",
    operations: [
      manifestOp.operation,
      gitignoreOp.operation,
      workspaceOp.operation,
      chatOp.operation,
    ],
    payloads: new Map([
      manifestOp.payload,
      gitignoreOp.payload,
      workspaceOp.payload,
      chatOp.payload,
    ]),
    createdAt,
  });
  if (result instanceof Error) {
    await lease.release();
    return result;
  }

  // The implicit trust grant: creating a project is itself the trust decision (storage-identity §8).
  const trust = makeTrustStore(deps);
  const subject = await trust.buildSubject(input.root, projectId, null);
  if (subject instanceof Error) {
    await lease.release();
    return subject;
  }
  const granted = await trust.grant(subject);
  if (granted instanceof Error) {
    await lease.release();
    return granted;
  }

  return assembleOpenProject({
    root: input.root,
    safeFs,
    lease,
    deps,
    recovery: { ok: true, recovered: 0, discarded: 0, alreadyComplete: 0 },
    orphanTurns: [],
    engine,
    writeMutex,
    manifestStore: makeManifestStore(safeFs),
    workspaceStateStore: makeWorkspaceStateStore(safeFs),
    projectId,
  });
}

// ---- the factory ----------------------------------------------------------------------

export function createStore(deps: StoreDeps): Store {
  return {
    openProject: (root) => openProject(deps, root),
    createProject: (input) => createProject(deps, input),
  };
}

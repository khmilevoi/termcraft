import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

import type { ChatHeader, ChatSystemErrorRecord } from "entities/chat";
import {
  PAGES_MANIFEST_RELPATH,
  PAGES_MANIFEST_SCHEMA_VERSION,
  encodePagesManifest,
} from "entities/design-tree";
import type { PageEntryV1, PagesManifestInvalidError, PagesManifestV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";
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
  // `canonicalPagePath` and `buildManifestOperation` are DELETED (design-tree canonical
  // source plan, Task 6): a page's file is now whatever `design/pages.json`'s `entry` says,
  // never computed from its slug. `renamePageTitle`/`reorderPages`/`removePage`/`readSource`
  // below resolve a page's file through `PagesManifestV1`'s `entry` map instead (Task 9),
  // built from `designFilePath`/`observeFileImage` the same way every other wrapper in
  // `store/transaction` already does. `pageCommentsPath` was RENAMED, not deleted (pin logs
  // are still slug-keyed, design §3) — its call sites below use `pinsJsonlPath`, a
  // mechanical rename with no behavior change.
  buildPinEventOperations,
  buildWorkspaceLocalPatchOperation,
  chatJsonlPath,
  createWriteMutex,
  designFilePath,
  ensureJournalFormat,
  finalizeTurn,
  nodeRecoveryFsDeps,
  nodeTransactionFsDeps,
  observeFileImage,
  pinsJsonlPath,
  readJournalFormat,
  recoverTransactions,
  runProjectMutation,
  terminalizeTurn,
} from "store/transaction";
import type {
  CommittedMarker,
  FileImage,
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
  ChatListEntry,
  ChatStore,
  CreateChatInput,
  CreateProjectInput,
  ManifestStore,
  OpenProject,
  OrphanTurnOutcome,
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
import { scanChatListingPrefix } from "./chat-listing";
import type { ChatListingScanIssue } from "./chat-listing";
import {
  buildPagesManifestOperation,
  createDesignTreeStore,
  readManifestFromDisk,
} from "./design-tree-store";

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

/** `reorderPages` was asked for an order that is not an exact permutation of `manifestBefore.pages`'s own slugs — never a subset, a superset, or a duplicate (`PageMutations.reorder`'s own port doc, `core/ports/design-store.ts`). */
export class ReorderPagesInvalidOrderError extends errore.createTaggedError({
  name: "ReorderPagesInvalidOrderError",
  message: "reorderPages: $reason",
}) {}

/**
 * `reorderPages`/`removePage` rebuild `design/pages.json` WHOLESALE from `manifestBefore` —
 * a snapshot the caller read BEFORE acquiring the write permit (`store/adapters/
 * design-store.ts`'s `reorder`/`remove` call `readManifest()` first, then separately invoke
 * the engine). `design/pages.json` has a second writer, turn finalize
 * (`store/adapters/turn-transactions.ts`), so that snapshot can go stale between the read
 * and the permit. The engine's own CAS (`buildPagesManifestOperation`'s `observeFileImage`)
 * cannot catch this on its own: it re-observes the CURRENT on-disk image, inside the SAME
 * permit, mere statements before using it as `oldImage` — which can never disagree with
 * itself. Without this check, a stale `manifestBefore` would silently overwrite whatever a
 * concurrent writer had just landed (e.g. a newly-finalized page, or a moved `entry`) with
 * content derived from the caller's outdated snapshot. Refused instead, by comparing
 * `manifestBefore` STRUCTURALLY (decoded field-by-field) against a freshly re-read and
 * re-decoded on-disk manifest — INSIDE the permit, immediately before either method does
 * anything else.
 *
 * NEVER compared by re-encoding `manifestBefore` and diffing bytes against the observed
 * on-disk image (review round 3's own finding, fixing round 2's original implementation):
 * `design/pages.json` is an AGENT-AUTHORED file `store/sandbox` stages verbatim into the
 * turn workspace and the system prompt tells the agent to edit directly, and a user may
 * hand-edit it too — its on-disk bytes are never guaranteed to match
 * `encodePagesManifest`'s own canonical output (fixed 2-space indent, fixed key order, and
 * `requestedActivePage: null` OMITTED rather than written explicitly,
 * `entities/design-tree/model/manifest.ts`). A byte comparison reports drift for a
 * SEMANTICALLY unchanged manifest and permanently refuses both mutating methods for any
 * project whose `pages.json` was ever touched by anything other than this file's own
 * writer — an unrecoverable-through-the-product regression the structural comparison does
 * not have: the engine's own per-operation `oldImage`/`newImage` CAS (`buildPagesManifestOperation`)
 * still independently covers true byte-level interleaving during the transaction itself.
 */
export class ManifestDriftedError extends errore.createTaggedError({
  name: "ManifestDriftedError",
  message:
    "design/pages.json changed since it was read; $method refuses rather than overwrite the drift",
}) {}

/**
 * `renamePageTitle` carries the identical unprotected-snapshot shape as
 * {@link ManifestDriftedError}, applied to its own TWO-part source instead of the whole
 * manifest: the caller (`store/adapters/design-store.ts`) resolves `entryRelPath` from a
 * manifest read, then separately reads THAT file's current bytes and computes a rewrite from
 * them — both BEFORE the write permit is acquired. Refused when either half has drifted
 * since:
 *
 * - `design/pages.json`'s binding for `pageSlug` no longer names `entryRelPath` at all — a
 *   concurrent writer moved the page's entry to a different path, or removed the page.
 *   Writing anyway would silently RESURRECT a file the manifest no longer considers this
 *   page's entry, at a path nothing else will ever read again.
 * - the entry file's own bytes no longer match `expectedSourceHash` — a concurrent writer
 *   (e.g. a turn finalize) replaced its content. The caller's `newBytes` was computed by
 *   mechanically rewriting a NOW-STALE read, so writing it would silently discard whatever
 *   the concurrent write added.
 *
 * Both checked FIRST, inside the permit, before any write — see
 * `assertEntrySourceNotDrifted`.
 */
export class EntrySourceDriftedError extends errore.createTaggedError({
  name: "EntrySourceDriftedError",
  message: "design-tree entry $entryRelPath for page $pageSlug changed since it was read: $reason",
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

// ---- design-tree page mutations (design §3, §4, §7) -----------------------------------
//
// `store/transaction/model/wrappers.ts`'s own `BuiltOperation`/`indexOperations`/
// `collectPayloads` are not exported (they are that file's private assembly detail), so the
// identical small shape is declared locally here rather than widening that module's public
// surface for three call sites. `store/model/design-tree-store.ts`'s `buildPagesManifestOperation`
// (design-tree phase-1 closeout, Task 9) declares its own identically-shaped private copy
// rather than importing this one — importing it would cycle back to this file, which also
// imports `design-tree-store.ts`'s three functions (`import/no-cycle`).

interface BuiltPageOperation {
  readonly operation: TransactionOperation;
  readonly payload?: readonly [string, Uint8Array];
}

function indexPageOperations(
  built: readonly BuiltPageOperation[],
): readonly TransactionOperation[] {
  return built.map((entry, index) => ({ ...entry.operation, index }));
}

function collectPagePayloads(
  built: readonly BuiltPageOperation[],
): ReadonlyMap<string, Uint8Array> {
  return new Map(built.flatMap((entry) => (entry.payload === undefined ? [] : [entry.payload])));
}

/** Field-by-field, order-sensitive equality (array order IS page order, design §4 — never a set comparison). Deliberately NOT a byte/hash comparison — see {@link ManifestDriftedError}'s own doc comment for why. */
function manifestStructurallyEqual(a: PagesManifestV1, b: PagesManifestV1): boolean {
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.requestedActivePage !== b.requestedActivePage) return false;
  if (a.pages.length !== b.pages.length) return false;
  return a.pages.every((entry, index) => {
    const other = b.pages[index];
    return other !== undefined && entry.slug === other.slug && entry.entry === other.entry;
  });
}

/**
 * The CAS precondition `reorderPages`/`removePage` need before they rebuild
 * `design/pages.json` wholesale from a caller-supplied `manifestBefore` snapshot — see
 * {@link ManifestDriftedError}'s own doc comment for why the engine's ordinary
 * `oldImage`/`newImage` CAS cannot catch this on its own, and for why the comparison is
 * STRUCTURAL rather than a byte/hash diff. MUST be called first, inside the permit, before
 * either method does anything else with `manifestBefore`.
 */
function assertManifestNotDrifted(
  deps: TransactionWrapperDeps,
  manifestBefore: PagesManifestV1,
  method: string,
): SafeFsError | PagesManifestInvalidError | ManifestDriftedError | null {
  const current = readManifestFromDisk(deps.fs.safeFs);
  if (current instanceof Error) return current;
  if (!manifestStructurallyEqual(current, manifestBefore)) {
    return new ManifestDriftedError({ method });
  }
  return null;
}

/**
 * The two-part CAS precondition `renamePageTitle` needs before it replaces an entry file
 * resolved by the CALLER, outside the permit — see {@link EntrySourceDriftedError}'s own doc
 * comment for the two ways this can drift and why the engine's ordinary `oldImage` CAS
 * cannot catch either on its own. Returns the entry file's freshly-observed `FileImage` on
 * success (the caller reuses it directly as the write operation's own `oldImage`, so this
 * check never reads the file's stat twice). MUST be called first, inside the permit, before
 * any write.
 */
function assertEntrySourceNotDrifted(
  fs: TransactionFsDeps,
  input: RenamePageTitleInput,
): SafeFsError | PagesManifestInvalidError | EntrySourceDriftedError | FileImage {
  const manifest = readManifestFromDisk(fs.safeFs);
  if (manifest instanceof Error) return manifest;
  const currentEntry = manifest.pages.find((page) => page.slug === input.pageSlug);
  if (currentEntry === undefined || currentEntry.entry !== input.entryRelPath) {
    return new EntrySourceDriftedError({
      pageSlug: input.pageSlug,
      entryRelPath: input.entryRelPath,
      reason: "design/pages.json no longer binds this page to this entry",
    });
  }

  const target = designFilePath(input.entryRelPath);
  const currentImage = observeFileImage(fs, target);
  if (currentImage instanceof Error) return currentImage;
  const matches =
    input.expectedSourceHash === null
      ? currentImage.state === "absent"
      : currentImage.state === "file" && currentImage.sha256 === input.expectedSourceHash;
  if (!matches) {
    return new EntrySourceDriftedError({
      pageSlug: input.pageSlug,
      entryRelPath: input.entryRelPath,
      reason: "the entry file's own bytes changed since they were read",
    });
  }
  return currentImage;
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
    // operation(s) from the already-landed builders (`buildWorkspaceLocalPatchOperation`,
    // `buildStandalonePinEventOperation`) — or, for `renamePageTitle`/`reorderPages`/
    // `removePage`, from `buildPagesManifestOperation` (`./design-tree-store`) and
    // `observeFileImage` — and runs them through the same `runProjectMutation` base engine
    // every other project mutation already uses.

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

    /**
     * `page.renameTitle`: `input.entryRelPath` names the exact tree-relative file to
     * replace — resolved by the CALLER through `design/pages.json` (design §3, §7). Refuses
     * with `EntrySourceDriftedError` (checked FIRST, inside the permit) when either the
     * manifest's binding for `pageSlug` or the entry file's own bytes drifted since the
     * caller observed them — see that class's own doc comment.
     */
    async renamePageTitle(input: RenamePageTitleInput) {
      return withPermit(mutex, async (permit) => {
        const oldImage = assertEntrySourceNotDrifted(fs, input);
        if (oldImage instanceof Error) return oldImage;

        const target = designFilePath(input.entryRelPath);
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

    /**
     * `page.reorder`: reorders `manifestBefore.pages` by `orderedSlugs`, refusing an order
     * that is not an exact permutation of the manifest's own slugs — never a subset, a
     * superset, or a duplicate. Each entry keeps its own `entry` value; reordering never
     * moves a page's source file. Already-current order is a legal, zero-operation
     * transaction, not a special-cased rejection. Refuses with `ManifestDriftedError`
     * (checked FIRST, inside the permit) when `manifestBefore` no longer matches what is
     * actually on disk — see that class's own doc comment.
     */
    async reorderPages(input: ReorderPagesInput) {
      return withPermit(mutex, async (permit) => {
        const drifted = assertManifestNotDrifted(wrapperDeps, input.manifestBefore, "reorderPages");
        if (drifted instanceof Error) return drifted;

        const bySlug = new Map(input.manifestBefore.pages.map((entry) => [entry.slug, entry]));
        const seen = new Set<PageSlug>();
        const reordered: PageEntryV1[] = [];
        for (const slug of input.orderedSlugs) {
          if (seen.has(slug))
            return new ReorderPagesInvalidOrderError({ reason: `duplicate pageSlug "${slug}"` });
          seen.add(slug);
          const entry = bySlug.get(slug);
          if (entry === undefined)
            return new ReorderPagesInvalidOrderError({ reason: `unknown pageSlug "${slug}"` });
          reordered.push(entry);
        }
        if (seen.size !== bySlug.size) {
          return new ReorderPagesInvalidOrderError({
            reason: `orderedSlugs names ${seen.size} of the manifest's ${bySlug.size} pages — every listed slug must appear exactly once`,
          });
        }

        const unchanged = reordered.every(
          (entry, index) => entry.slug === input.manifestBefore.pages[index]?.slug,
        );

        const built: BuiltPageOperation[] = [];
        if (!unchanged) {
          const nextManifest: PagesManifestV1 = { ...input.manifestBefore, pages: reordered };
          const manifestOp = buildPagesManifestOperation(wrapperDeps, nextManifest);
          if (manifestOp instanceof Error) return manifestOp;
          built.push(manifestOp);
        }

        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "page-reorder",
          operations: indexPageOperations(built),
          payloads: collectPagePayloads(built),
          createdAt: input.createdAt,
        });
      });
    },

    /**
     * `page.removeConfirm`: drops the manifest entry (if any), deletes its entry file (if
     * any), and deletes its pin log — nothing else. A shared module the removed page's
     * entry imported is NEVER deleted (design §8 step 3: the design refuses to auto-delete a
     * dead module). A slug already absent from the manifest is a legal no-op on that half
     * (idempotent retry); a page with no entry file yet only deletes its pin log. Refuses
     * with `ManifestDriftedError` (checked FIRST, inside the permit) when `manifestBefore`
     * no longer matches what is actually on disk — see that class's own doc comment.
     */
    async removePage(input: RemovePageInput) {
      return withPermit(mutex, async (permit) => {
        const drifted = assertManifestNotDrifted(wrapperDeps, input.manifestBefore, "removePage");
        if (drifted instanceof Error) return drifted;

        const entry = input.manifestBefore.pages.find((page) => page.slug === input.pageSlug);
        const nextPages = input.manifestBefore.pages.filter((page) => page.slug !== input.pageSlug);
        const nextRequestedActivePage =
          input.manifestBefore.requestedActivePage === input.pageSlug
            ? null
            : input.manifestBefore.requestedActivePage;
        const manifestChanged =
          nextPages.length !== input.manifestBefore.pages.length ||
          nextRequestedActivePage !== input.manifestBefore.requestedActivePage;

        const built: BuiltPageOperation[] = [];
        if (manifestChanged) {
          const nextManifest: PagesManifestV1 = {
            ...input.manifestBefore,
            pages: nextPages,
            requestedActivePage: nextRequestedActivePage,
          };
          const manifestOp = buildPagesManifestOperation(wrapperDeps, nextManifest);
          if (manifestOp instanceof Error) return manifestOp;
          built.push(manifestOp);
        }

        if (entry !== undefined) {
          const target = designFilePath(entry.entry);
          const oldImage = observeFileImage(fs, target);
          if (oldImage instanceof Error) return oldImage;
          built.push({
            operation: {
              index: 0,
              target,
              mode: "delete",
              oldImage,
              newImage: { state: "absent" },
            },
          });
        }

        const pinsTarget = pinsJsonlPath(input.pageSlug);
        const pinsOldImage = observeFileImage(fs, pinsTarget);
        if (pinsOldImage instanceof Error) return pinsOldImage;
        built.push({
          operation: {
            index: 0,
            target: pinsTarget,
            mode: "delete",
            oldImage: pinsOldImage,
            newImage: { state: "absent" },
          },
        });

        return runProjectMutation(wrapperDeps, {
          mutex,
          permit,
          transactionId: input.transactionId,
          actionId: input.actionId,
          mutationKind: "page-remove",
          operations: indexPageOperations(built),
          payloads: collectPagePayloads(built),
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

// ---- design tree + pins (design §3, §4, §6) ----------------------------------------------

/**
 * storage-identity §5.2: "A comments header's `projectId` and `pageSlug` must equal its
 * containing project and directory. Mismatch is corruption; readers do not repair identity by
 * renaming files or rewriting headers." A file with no readable header at all cannot carry a
 * matching identity either, so it is rejected the same way (major finding #2).
 */
function makePinStore(safeFs: SafeProjectFs, projectId: string): PinStore {
  return {
    async fold(pageSlug) {
      const relPath = pinsJsonlPath(pageSlug);
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
 *
 * `list()` (fix-bundle spec §2.1, Gap E) applies the SAME §5.2 identity check on its own
 * bounded-prefix scan (`./chat-listing.ts`'s `scanChatListingPrefix`) rather than going
 * through `open`'s persisted index at all — listing every chat under the project needs none
 * of the index's incremental-append machinery, only each file's own head.
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

    /**
     * Bounded per chat: one `stat` plus one `readRange` of at most
     * {@link CHAT_INDEX_SCAN_CHUNK_BYTES} bytes (projections §16.1's own chat scan buffer),
     * never a whole-file read — unlike `scanOrphanTurns`, which genuinely needs every record.
     * The first `user` record is at the file's head by construction, so this bound is generous
     * rather than lossy; a chat whose first user record somehow sits past it lists with a `null`
     * name and falls back to the UI's own design-sourced `new chat — fresh context` label.
     */
    async list() {
      const names = safeFs.list("chats");
      if (names instanceof Error) {
        if (names instanceof FsAccessError && isNotFound(names)) return [];
        return names;
      }

      const entries: ChatListEntry[] = [];
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const chatId = name.slice(0, -".jsonl".length);
        const relPath = chatJsonlPath(chatId);

        const stat = safeFs.stat(relPath);
        if (stat instanceof Error) {
          console.warn(`store: chat listing could not stat ${relPath}:`, stat.message);
          continue;
        }
        // A genuinely empty file is neither an identity mismatch nor a decode failure — it is
        // most likely a chat header whose durable write has not landed yet — so it gets its
        // own honest message rather than borrowing `scanChatListingPrefix`'s generic ones
        // (review fix round 1, Minor).
        if (stat.size === 0) {
          console.warn(`store: chat listing skipping ${relPath}, chat file is empty`);
          continue;
        }
        const prefix = safeFs.readRange(
          relPath,
          0,
          Math.min(stat.size, CHAT_INDEX_SCAN_CHUNK_BYTES),
        );
        if (prefix instanceof Error) {
          console.warn(`store: chat listing could not read ${relPath}:`, prefix.message);
          continue;
        }

        const entry = scanChatListingPrefix(prefix, chatId, projectId, (issue) =>
          logChatListingIssue(relPath, issue),
        );
        if (entry !== null) entries.push(entry);
      }
      return entries;
    },
  };
}

/**
 * `scanChatListingPrefix`'s `onIssue` sink (review fix round 1, Finding 1/2): every reason a
 * row is skipped, or kept but left unnamed, is logged with the REAL cause — never a generic
 * catch-all — matching `scanOrphanTurns`'s own precedent of logging `doc.message` rather than
 * a fixed string (errore rule 21).
 */
function logChatListingIssue(relPath: string, issue: ChatListingScanIssue): void {
  if (issue.kind === "no-header-line") {
    console.warn(`store: chat listing skipping ${relPath}, no complete header line found`);
    return;
  }
  if (issue.kind === "header-unreadable") {
    console.warn(
      `store: chat listing skipping ${relPath}, chat header unreadable:`,
      issue.cause.message,
    );
    return;
  }
  if (issue.kind === "identity-mismatch") {
    console.warn(
      `store: chat listing skipping ${relPath}, chat header names chatId ${issue.headerChatId} projectId ${issue.headerProjectId}, which does not match its filename/project`,
    );
    return;
  }
  console.warn(
    `store: chat listing ${relPath} has an unreadable record before its first user record — listing it without a name:`,
    issue.cause.message,
  );
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
    pages: createDesignTreeStore(safeFs),
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
  // THE SEEDED DESIGN TREE (multi-file design tree §3, §10): `design/pages.json` with an
  // EMPTY `pages` array and nothing else. A brand-new project has no page and gets no starter
  // page — §10 seeds "`design/pages.json` and an empty conventional structure", and inventing
  // a first page would put a design the user never asked for in front of them and a file the
  // agent then has to work around. The first turn creates one; until then `pages: []` is the
  // honest state, and it is what makes `openProject` readable at all (`readManifestFromDisk`,
  // now in `./design-tree-store`, needs the file to exist, and an absent one is what
  // `probeProjectContent` reads as "no content yet"). `lib/`, `components/` and the rest of
  // §3's conventional directories are
  // NOT created: an empty directory is not representable in a transaction operation, carries no
  // information, and the agent creates one the moment it writes into it.
  const pagesManifestBytes = new TextEncoder().encode(
    encodePagesManifest({
      schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
      pages: [],
      requestedActivePage: null,
    }),
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
  const pagesOp = buildReplaceOperation(
    deps,
    4,
    designFilePath(PAGES_MANIFEST_RELPATH),
    pagesManifestBytes,
  );

  // ONE project-mutation transaction mints projectId + the format-2 layout + the generated
  // .gitignore + the workspace file + the first chat header + the seeded design tree
  // (storage-identity §14.2; multi-file design tree §3, §10).
  const result = await engine.runProjectMutation({
    transactionId: deps.uuidv7(),
    actionId: deps.uuidv7(),
    mutationKind: "project-creation",
    operations: [
      manifestOp.operation,
      gitignoreOp.operation,
      workspaceOp.operation,
      chatOp.operation,
      pagesOp.operation,
    ],
    payloads: new Map([
      manifestOp.payload,
      gitignoreOp.payload,
      workspaceOp.payload,
      chatOp.payload,
      pagesOp.payload,
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

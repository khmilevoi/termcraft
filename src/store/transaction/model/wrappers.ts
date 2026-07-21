import * as errore from "errore";

import type {
  ChatAgentRecord,
  ChatRecord,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
} from "entities/chat";
import type { PageSlug } from "entities/page";
import type { PinEvent, PinStatusEvent } from "entities/pin";
import type { AppendBase, AppendBuilderDeps } from "store/jsonl";
import {
  buildChatAppend,
  buildPinAppend,
  computeAfterImage,
  encodeCommentsHeaderLine,
  encodePinEventLine,
  readChatJsonl,
  readPinsJsonl,
  sha256Hex,
} from "store/jsonl";
import { FsAccessError, isNotFound } from "store/safe-fs";
import type { SafeFsError } from "store/safe-fs";
import type { ProjectManifest, WorkspaceLocalState } from "store/toml";
import {
  PROJECT_MANIFEST_FILENAME,
  WORKSPACE_STATE_FILENAME,
  encodeProjectManifest,
  encodeWorkspaceLocalState,
  loadWorkspaceLocalState,
} from "store/toml";

import type {
  FileImage,
  ProjectWritePermit,
  Sha256Hex,
  TransactionOperation,
  TransactionPlan,
} from "../types";
import type { TransactionFsDeps } from "./engine";
import { runTransaction } from "./engine";
import { TRANSACTION_JOURNAL_FORMAT_VERSION } from "./plan";
import type { WriteMutex } from "./write-mutex";

// The four named domain wrappers over `ProjectTransaction` (turn-durability §6-§11) plus
// `project-mutation`, the base-engine kind ordinary ProjectStore actions use without a
// dedicated top-level component (turn-durability §1). Each wrapper decides which exact old
// and new file images belong in its plan — the engine (`./engine.ts`) owns only durability,
// CAS, ordering, and roll-forward, never domain meaning.
//
// SCOPE: `TurnTransaction` (admission/finalization/terminalization) is the fully-built
// wrapper this phase's turn flow needs and is exercised by the task's full test matrix.
// `project-mutation` is a thin, generically-typed pass-through plus one convenience builder
// (`buildStandalonePinEventOperation`) that demonstrates the append path a real project-
// mutation caller (a future `store/toml`/`store/jsonl` action, phase 6) would use.
// `RestoreTransaction`/`ExportPublishTransaction`/`MigrationTransaction` are INFRASTRUCTURE
// ONLY (plan "Deferred / cross-phase"): each is built and unit-tested here so recovery
// (T14) and the engine (T13) have already proven their shared protocol works for these
// kinds, but MVP wires NO caller for any of the three. In particular Restore is out of MVP
// scope entirely (roadmap Out-of-scope) — no phase-4 code path ever calls
// `buildRestoreTransaction`, so no `system:restore` record is ever written by a live path.

// ---- managed path helpers (storage-identity §4; store/safe-fs/model/limits.ts namespaces) --

export function chatJsonlPath(chatId: string): string {
  return `chats/${chatId}.jsonl`;
}
export function canonicalPagePath(slug: PageSlug): string {
  return `pages/${slug}/page.tsx`;
}
export function pageCommentsPath(slug: PageSlug): string {
  return `pages/${slug}/comments.jsonl`;
}

// ---- shared errors --------------------------------------------------------------------

/**
 * A chat or comments log's tail is not `clean` (storage-identity §11.3 case 2 or 3) —
 * either an unproven corrupt suffix under a mutation lock, or (should recovery ever be
 * skipped) a transaction-proven interruption nothing here is prepared to resume. A wrapper
 * never appends onto a non-clean tail; startup recovery (T14) is what resolves case 1, and
 * an explicit repair (`jsonl-repair` project-mutation) is what resolves case 2.
 */
export class ChatMutationLockedError extends errore.createTaggedError({
  name: "ChatMutationLockedError",
  message:
    "$path is mutation-locked by an unresolved tail; explicit repair is required before append",
}) {}

/** A caller passed a finalization input the wrapper cannot turn into a plan (e.g. a `replace` page with no bytes). */
export class TurnFinalizeInputError extends errore.createTaggedError({
  name: "TurnFinalizeInputError",
  message: "invalid turn finalization input: $reason",
}) {}

/**
 * `terminalizeTurn`/orphan recovery was asked to terminalize a `turnId` that has no `user`
 * record in the target chat (turn-durability §7.7: "same turnId in multiple chats" /
 * "terminal record without its user record" is `chat_corrupt`). The most common cause is a
 * caller pointing the wrapper at the wrong chat — hence "cross-chat" in the task brief.
 */
export class TurnRecordNotFoundError extends errore.createTaggedError({
  name: "TurnRecordNotFoundError",
  message: "no user record for turn $turnId exists in chat $targetChatId",
}) {}

/**
 * `turnId` already has a terminal record (`agent`/`system:error`/`system:cancelled`) in the
 * target chat. `terminalizeTurn` refuses to append a second one — this is what makes repeated
 * orphan-scan terminalization (turn-durability §7.7) idempotent: exactly one terminal record
 * per turn, ever, even across restarts that rescan the same interrupted turn.
 */
export class TurnAlreadyTerminalError extends errore.createTaggedError({
  name: "TurnAlreadyTerminalError",
  message: "turn $turnId already has a terminal record in chat $targetChatId",
}) {}

/** turn-durability §7.5 / §13: a canonical page, the page inventory, or the portable manifest drifted since the turn's send-time read set. */
export class SourceChangedError extends errore.createTaggedError({
  name: "SourceChangedError",
  message: "source_changed: $part drifted from the turn's send-time read set",
}) {}

/** turn-durability §7.5 / §13: the captured chat or a relevant comments log drifted since the turn's send-time read set. */
export class StaleError extends errore.createTaggedError({
  name: "StaleError",
  message: "stale: $part drifted from the turn's send-time read set",
}) {}

// ---- wrapper-wide injected deps ---------------------------------------------------------

/**
 * Every wrapper in this file needs exactly two impure seams: `fs` (the already-landed
 * `TransactionFsDeps` — `SafeProjectFs` reads plus the durable-write/flush/mkdir/unlink
 * primitives `./engine.ts` defines) and `append` (the UUIDv7 minter `store/jsonl`'s append
 * builder already declares as `AppendBuilderDeps`). The same minter is reused for every
 * `replace` operation's `payloadId` too — it is just `uuidv7`, so introducing a second
 * differently-named dependency for the identical capability would add a seam without adding
 * a real degree of freedom.
 */
export interface TransactionWrapperDeps {
  readonly fs: TransactionFsDeps;
  readonly append: AppendBuilderDeps;
}

// ---- shared "before" state + image helpers ----------------------------------------------

interface JsonlBeforeState<R> {
  readonly bytes: Uint8Array;
  readonly base: AppendBase;
  readonly records: readonly R[];
}

function emptyBefore<R>(): JsonlBeforeState<R> {
  return {
    bytes: new Uint8Array(0),
    base: { length: 0, prefixSha256: sha256Hex(new Uint8Array(0)) },
    records: [],
  };
}

/** Read a chat JSONL's current valid-prefix state through `SafeProjectFs`. A missing file is a legitimate empty "before" (project-mutation creates the header itself). */
function readChatBefore(
  fs: TransactionFsDeps,
  relPath: string,
): SafeFsError | ChatMutationLockedError | Error | JsonlBeforeState<ChatRecord> {
  const bytes = fs.safeFs.readFile(relPath);
  if (bytes instanceof Error && bytes instanceof FsAccessError && isNotFound(bytes))
    return emptyBefore();
  if (bytes instanceof Error) return bytes;

  const doc = readChatJsonl({ path: relPath, chunks: [bytes] });
  if (doc instanceof Error) return doc;
  if (doc.tail.kind !== "clean") return new ChatMutationLockedError({ path: relPath });
  return {
    bytes,
    base: { length: doc.validPrefixBytes, prefixSha256: doc.prefixSha256 },
    records: doc.records,
  };
}

/** Read a comments JSONL's current valid-prefix state through `SafeProjectFs`. */
function readPinsBefore(
  fs: TransactionFsDeps,
  relPath: string,
): SafeFsError | ChatMutationLockedError | Error | JsonlBeforeState<PinEvent> {
  const bytes = fs.safeFs.readFile(relPath);
  if (bytes instanceof Error && bytes instanceof FsAccessError && isNotFound(bytes))
    return emptyBefore();
  if (bytes instanceof Error) return bytes;

  const doc = readPinsJsonl({ path: relPath, chunks: [bytes] });
  if (doc instanceof Error) return doc;
  if (doc.tail.kind !== "clean") return new ChatMutationLockedError({ path: relPath });
  return {
    bytes,
    base: { length: doc.validPrefixBytes, prefixSha256: doc.prefixSha256 },
    records: doc.records,
  };
}

/** The `FileImage` an append operation's `oldImage` must carry for a given "before" state (turn-durability §3.3: `beforeLength === 0` implies `absent`). */
function fileImageForBefore(base: AppendBase): FileImage {
  return base.length === 0
    ? { state: "absent" }
    : { state: "file", sha256: base.prefixSha256, size: base.length };
}

/**
 * Observe a fixed (non-JSONL) managed target's current `FileImage`, e.g. `project.toml` or
 * one canonical page. Exported (phase-6 blocker B3) so `store/model/factory.ts`'s named
 * `TransactionEngine` methods can build their own `replace`/`delete` operations from the
 * same current-state observation this file's own wrappers already use — reusing the
 * primitive rather than re-implementing the identical `readFile`/`isNotFound` dance.
 */
export function observeFileImage(fs: TransactionFsDeps, relPath: string): SafeFsError | FileImage {
  const bytes = fs.safeFs.readFile(relPath);
  if (bytes instanceof Error && bytes instanceof FsAccessError && isNotFound(bytes))
    return { state: "absent" };
  if (bytes instanceof Error) return bytes;
  return { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength };
}

function imagesEqual(a: FileImage, b: FileImage): boolean {
  if (a.state === "absent" && b.state === "absent") return true;
  if (a.state === "file" && b.state === "file") return a.sha256 === b.sha256 && a.size === b.size;
  return false;
}

// One built operation plus the payload bytes it references, if any. `index` is a placeholder
// — every wrapper below assembles its full operation list first, then assigns real indices
// by final array position, so each builder never has to know its position among its siblings.
interface BuiltOperation {
  readonly operation: TransactionOperation;
  readonly payload?: readonly [string, Uint8Array];
}

function indexOperations(built: readonly BuiltOperation[]): readonly TransactionOperation[] {
  return built.map((entry, index) => ({ ...entry.operation, index }));
}

function collectPayloads(built: readonly BuiltOperation[]): ReadonlyMap<string, Uint8Array> {
  return new Map(built.flatMap((entry) => (entry.payload === undefined ? [] : [entry.payload])));
}

// ======================================================================================
// TurnTransaction (turn-durability §6-§7)
// ======================================================================================

// ---- admission (§6.1 invariant 9, §7.2 step 3) -------------------------------------------

export interface TurnAdmissionInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly turnId: string;
  readonly targetChatId: string;
  /** Fully built by the caller — text/selection/pins/`ts` are domain decisions this module never makes. */
  readonly userRecord: ChatUserRecord;
  readonly createdAt: string;
}

/**
 * Admission: append exactly the user record to `targetChatId`, and commit it BEFORE any
 * agent process starts (turn-durability invariant 9, §7.2 step 3). This is the whole of the
 * admission phase — workspace assembly and the send-time read-set capture that follow it in
 * §7.2 steps 4-5 are `store/sandbox`'s job (T16), not this engine's.
 */
export async function admitTurn(deps: TransactionWrapperDeps, input: TurnAdmissionInput) {
  const chatPath = chatJsonlPath(input.targetChatId);
  const before = readChatBefore(deps.fs, chatPath);
  if (before instanceof Error) return before;

  const appended = buildChatAppend({
    before: before.base,
    records: [input.userRecord],
    domainIdentity: input.turnId,
    deps: deps.append,
  });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;

  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "turn",
    domain: { turnId: input.turnId, phase: "admission", targetChatId: input.targetChatId },
    createdAt: input.createdAt,
    operations: [
      {
        index: 0,
        target: chatPath,
        mode: "append-jsonl",
        oldImage: fileImageForBefore(before.base),
        newImage: { state: "file", sha256: after.sha256, size: after.size },
        append: appended.descriptor,
      },
    ],
  };

  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: new Map([[appended.descriptor.appendedPayloadId, appended.bytes]]),
  });
}

// ---- finalization (§7.4, §7.5) ------------------------------------------------------------

export interface ChangedPageOp {
  readonly pageSlug: PageSlug;
  readonly change: "replace" | "delete";
  /** Required when `change === "replace"` — the page's complete new bytes. */
  readonly newBytes?: Uint8Array;
}

export interface ResolvedPinAppend {
  readonly pageSlug: PageSlug;
  /** Fully built by the caller: `status: "resolved"`, `turnId` set, `actionId` absent. */
  readonly event: PinStatusEvent;
}

/**
 * The full send-time read set turn-durability §7.5 re-checks immediately before intent.
 * Captured once at admission (§7.2 step 4, `store/sandbox`'s `turn.json` — not yet landed)
 * and threaded through to finalization by the caller; this module only compares it against
 * freshly observed current state.
 */
export interface TurnReadSet {
  readonly manifest: FileImage;
  /** Every canonical page exposed to the agent, INCLUDING expected-absent entries for potential new targets (§7.5). */
  readonly canonicalPages: ReadonlyMap<PageSlug, FileImage>;
  readonly chat: AppendBase;
  /** Every comments log whose selection or sent pins contributed context (§7.2 step 4). */
  readonly pins: ReadonlyMap<PageSlug, AppendBase>;
}

/**
 * CRITICAL (plan "Deferred / cross-phase" — `pages.json` vs `project.toml.pages`):
 * `pages.json` is the TRANSIENT agent-workspace manifest slice inside the turn
 * workspace/candidate (`store/sandbox`, T16 — not landed) — it is Gate-validated there and
 * NEVER written as a portable file. `project.toml.pages` is the PORTABLE durable ordered
 * slug array. `validatedPageSlugs` below is that already-Gate-validated `pages.json` ordered
 * slug array, handed to this wrapper by the caller (finalization does not re-open or
 * re-validate `pages.json` itself); this wrapper's only job is deriving the new
 * `project.toml` from it (turn-durability §7.4 item 2: "portable `project.toml` changes
 * derived from validated `pages.json`, containing only ordered page slugs ... never cached
 * metadata"). No code path in this file ever writes a `pages.json` file.
 */
export interface TurnFinalizeInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly turnId: string;
  readonly targetChatId: string;
  /** Gate-validated diff; empty means no canonical page changed. */
  readonly changedPages: readonly ChangedPageOp[];
  /** The validated `pages.json` ordered slug array — see the CRITICAL note above. */
  readonly validatedPageSlugs: readonly PageSlug[];
  /** The portable manifest as observed at the START of finalization (before the fresh re-observe below). */
  readonly manifestBefore: ProjectManifest;
  /** Present only when the candidate explicitly requests a different active page (§7.4 item 3). */
  readonly requestedActivePage?: PageSlug | null;
  /** Fully built by the caller: `changedPages`/`warnings`/`text` are Gate/agent outcomes this module never computes. */
  readonly agentRecord: ChatAgentRecord;
  /** Every sent pin resolved by this turn — filtered down to `changedPages` internally (§7.4 item 5). */
  readonly resolvedPins: readonly ResolvedPinAppend[];
  readonly readSet: TurnReadSet;
  readonly createdAt: string;
}

function buildChangedPageOperation(
  deps: TransactionWrapperDeps,
  page: ChangedPageOp,
): SafeFsError | TurnFinalizeInputError | BuiltOperation {
  const target = canonicalPagePath(page.pageSlug);
  const oldImage = observeFileImage(deps.fs, target);
  if (oldImage instanceof Error) return oldImage;

  if (page.change === "delete") {
    return {
      operation: { index: 0, target, mode: "delete", oldImage, newImage: { state: "absent" } },
    };
  }
  if (page.newBytes === undefined)
    return new TurnFinalizeInputError({
      reason: `page ${page.pageSlug} is a replace with no newBytes`,
    });

  const payloadId = deps.append.newPayloadId();
  return {
    operation: {
      index: 0,
      target,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(page.newBytes), size: page.newBytes.byteLength },
      payloadId,
    },
    payload: [payloadId, page.newBytes],
  };
}

/**
 * turn-durability §7.4 item 2 — `null` when `validatedPageSlugs` already matches the durable
 * manifest (no unrelated file is touched). Exported (phase-6 blocker B3): `page.reorder` and
 * `page.removeConfirm` are both, at bottom, "rewrite `project.toml`'s page order" — the exact
 * operation this helper already builds for turn finalization — so `store/model/factory.ts`'s
 * named methods reuse it rather than re-deriving the same replace operation a second way.
 */
export function buildManifestOperation(
  deps: TransactionWrapperDeps,
  before: ProjectManifest,
  validatedPageSlugs: readonly PageSlug[],
): SafeFsError | BuiltOperation | null {
  const unchanged =
    before.pages.length === validatedPageSlugs.length &&
    before.pages.every((slug, at) => slug === validatedPageSlugs[at]);
  if (unchanged) return null;

  const oldImage = observeFileImage(deps.fs, PROJECT_MANIFEST_FILENAME);
  if (oldImage instanceof Error) return oldImage;

  const nextManifest: ProjectManifest = { ...before, pages: validatedPageSlugs };
  const bytes = new TextEncoder().encode(encodeProjectManifest(nextManifest));
  const payloadId = deps.append.newPayloadId();
  return {
    operation: {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    },
    payload: [payloadId, bytes],
  };
}

/**
 * Build a `workspace.local.toml` replace operation from a caller-supplied patch of the
 * THEN-CURRENT local state, so unrelated preferences/session checkpoints are preserved
 * (turn-durability §7.4 item 3's exact discipline, generalized). Exported (phase-6 blocker
 * B3): every machine-local write `TransactionEngine` gains a named method for — active
 * chat, active page, `model.select`, and every other local field, plus checkpoint advance —
 * is this same "read current, patch, replace" shape with a different `patch` function.
 */
export function buildWorkspaceLocalPatchOperation(
  deps: TransactionWrapperDeps,
  patch: (current: WorkspaceLocalState) => WorkspaceLocalState,
): SafeFsError | BuiltOperation {
  const current = deps.fs.safeFs.readFile(WORKSPACE_STATE_FILENAME);
  if (current instanceof Error && !(current instanceof FsAccessError && isNotFound(current)))
    return current;
  const currentBytes = current instanceof Error ? null : current;

  const loaded = loadWorkspaceLocalState({
    text: currentBytes === null ? null : new TextDecoder().decode(currentBytes),
  });
  const nextState = patch(loaded.state);
  const bytes = new TextEncoder().encode(encodeWorkspaceLocalState(nextState));
  const oldImage: FileImage =
    currentBytes === null
      ? { state: "absent" }
      : { state: "file", sha256: sha256Hex(currentBytes), size: currentBytes.byteLength };
  const payloadId = deps.append.newPayloadId();
  return {
    operation: {
      index: 0,
      target: WORKSPACE_STATE_FILENAME,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    },
    payload: [payloadId, bytes],
  };
}

/** turn-durability §7.4 item 3 — the finalization-specific case of {@link buildWorkspaceLocalPatchOperation}: set only `activePageSlug`. */
function buildWorkspaceLocalOperation(
  deps: TransactionWrapperDeps,
  requestedActivePage: PageSlug,
): SafeFsError | BuiltOperation {
  return buildWorkspaceLocalPatchOperation(deps, (current) => ({
    ...current,
    activePageSlug: requestedActivePage,
  }));
}

function buildAgentRecordOperation(
  deps: TransactionWrapperDeps,
  chatPath: string,
  turnId: string,
  record: ChatAgentRecord,
): SafeFsError | ChatMutationLockedError | Error | BuiltOperation {
  const before = readChatBefore(deps.fs, chatPath);
  if (before instanceof Error) return before;
  const appended = buildChatAppend({
    before: before.base,
    records: [record],
    domainIdentity: turnId,
    deps: deps.append,
  });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;
  return {
    operation: {
      index: 0,
      target: chatPath,
      mode: "append-jsonl",
      oldImage: fileImageForBefore(before.base),
      newImage: { state: "file", sha256: after.sha256, size: after.size },
      append: appended.descriptor,
    },
    payload: [appended.descriptor.appendedPayloadId, appended.bytes],
  };
}

/** One append-jsonl operation per page, batching every resolved pin for that page into a single prepared append. */
function buildPinResolutionOperation(
  deps: TransactionWrapperDeps,
  pageSlug: PageSlug,
  events: readonly PinStatusEvent[],
): SafeFsError | ChatMutationLockedError | Error | BuiltOperation {
  const target = pageCommentsPath(pageSlug);
  const before = readPinsBefore(deps.fs, target);
  if (before instanceof Error) return before;
  const appended = buildPinAppend({ before: before.base, events, deps: deps.append });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;
  return {
    operation: {
      index: 0,
      target,
      mode: "append-jsonl",
      oldImage: fileImageForBefore(before.base),
      newImage: { state: "file", sha256: after.sha256, size: after.size },
      append: appended.descriptor,
    },
    payload: [appended.descriptor.appendedPayloadId, appended.bytes],
  };
}

function groupResolvedPins(pins: readonly ResolvedPinAppend[]): Map<PageSlug, PinStatusEvent[]> {
  const grouped = new Map<PageSlug, PinStatusEvent[]>();
  for (const pin of pins) {
    const existing = grouped.get(pin.pageSlug);
    if (existing === undefined) {
      grouped.set(pin.pageSlug, [pin.event]);
      continue;
    }
    existing.push(pin.event);
  }
  return grouped;
}

/** turn-durability §7.5: re-observe the complete send-time read set immediately before intent; any drift is `source_changed`/`stale`, never an overwrite. */
function buildFinalizeCasPrecondition(
  fs: TransactionFsDeps,
  chatPath: string,
  readSet: TurnReadSet,
) {
  return ():
    | SourceChangedError
    | StaleError
    | SafeFsError
    | ChatMutationLockedError
    | Error
    | null => {
    const manifestNow = observeFileImage(fs, PROJECT_MANIFEST_FILENAME);
    if (manifestNow instanceof Error) return manifestNow;
    if (!imagesEqual(manifestNow, readSet.manifest))
      return new SourceChangedError({ part: "manifest" });

    for (const [slug, expected] of readSet.canonicalPages) {
      const now = observeFileImage(fs, canonicalPagePath(slug));
      if (now instanceof Error) return now;
      if (!imagesEqual(now, expected)) return new SourceChangedError({ part: `canonical:${slug}` });
    }

    const chatNow = readChatBefore(fs, chatPath);
    if (chatNow instanceof Error) return chatNow;
    if (
      chatNow.base.length !== readSet.chat.length ||
      chatNow.base.prefixSha256 !== readSet.chat.prefixSha256
    ) {
      return new StaleError({ part: "chat" });
    }

    for (const [slug, expected] of readSet.pins) {
      const now = readPinsBefore(fs, pageCommentsPath(slug));
      if (now instanceof Error) return now;
      if (now.base.length !== expected.length || now.base.prefixSha256 !== expected.prefixSha256) {
        return new StaleError({ part: `pins:${slug}` });
      }
    }

    return null;
  };
}

/**
 * Finalization (turn-durability §7.4, §7.5): the canonical operation order is changed
 * canonical pages (sorted by slug) → the derived `project.toml` (only when page order
 * changed) → an optional `workspace.local.toml` active-page replacement → exactly one agent
 * record → one append-only `pin:status resolved` per resolved sent pin (only for pages the
 * turn actually changed — an empty diff resolves none, regardless of what the caller passed
 * in `resolvedPins`). The full send-time CAS runs as the engine's `precondition` step,
 * immediately before intent (§7.5) — a match commits every effect in one transaction, and a
 * mismatch commits none of them.
 */
export async function finalizeTurn(deps: TransactionWrapperDeps, input: TurnFinalizeInput) {
  const chatPath = chatJsonlPath(input.targetChatId);
  const built: BuiltOperation[] = [];

  const sortedPages = [...input.changedPages].sort((a, b) =>
    a.pageSlug < b.pageSlug ? -1 : a.pageSlug > b.pageSlug ? 1 : 0,
  );
  for (const page of sortedPages) {
    const result = buildChangedPageOperation(deps, page);
    if (result instanceof Error) return result;
    built.push(result);
  }

  const manifestOp = buildManifestOperation(deps, input.manifestBefore, input.validatedPageSlugs);
  if (manifestOp instanceof Error) return manifestOp;
  if (manifestOp !== null) built.push(manifestOp);

  if (input.requestedActivePage !== undefined && input.requestedActivePage !== null) {
    const workspaceOp = buildWorkspaceLocalOperation(deps, input.requestedActivePage);
    if (workspaceOp instanceof Error) return workspaceOp;
    built.push(workspaceOp);
  }

  const agentOp = buildAgentRecordOperation(deps, chatPath, input.turnId, input.agentRecord);
  if (agentOp instanceof Error) return agentOp;
  built.push(agentOp);

  // §7.4 item 5: "An empty design diff resolves no pin." Filtering here — rather than
  // trusting the caller to have already filtered — makes that invariant hold even if a
  // caller passes stale/candidate resolutions alongside an empty `changedPages`.
  const changedSlugs = new Set(input.changedPages.map((page) => page.pageSlug));
  const eligiblePins = input.resolvedPins.filter((pin) => changedSlugs.has(pin.pageSlug));
  const grouped = groupResolvedPins(eligiblePins);
  for (const slug of [...grouped.keys()].sort()) {
    const events = grouped.get(slug);
    if (events === undefined) continue;
    const result = buildPinResolutionOperation(deps, slug, events);
    if (result instanceof Error) return result;
    built.push(result);
  }

  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "turn",
    domain: { turnId: input.turnId, phase: "finalization", targetChatId: input.targetChatId },
    createdAt: input.createdAt,
    operations: indexOperations(built),
  };

  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: collectPayloads(built),
    precondition: buildFinalizeCasPrecondition(deps.fs, chatPath, input.readSet),
  });
}

// ---- terminalization (§7.6, §7.7) ---------------------------------------------------------

export type TurnTerminalRecord = ChatSystemErrorRecord | ChatSystemCancelledRecord;

export interface TurnTerminalizeInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly turnId: string;
  readonly targetChatId: string;
  /** Fully built by the caller: `system:error` (outcome `error`/`stale`/`interrupted`) or `system:cancelled`, with `turnId` set. */
  readonly record: TurnTerminalRecord;
  readonly createdAt: string;
}

function isTerminalRecordFor(record: ChatRecord, turnId: string): boolean {
  if (record.kind === "agent") return record.turnId === turnId;
  if (record.kind === "system:error" || record.kind === "system:cancelled")
    return record.turnId === turnId;
  return false;
}

/**
 * Terminalization (turn-durability §7.6): appends exactly one system record to the captured
 * chat and never touches pages, manifest, or pins. Two domain guards make repeated orphan-
 * scan terminalization (§7.7) safe to call more than once for the same `turnId`:
 *
 * - no `user` record for `turnId` in this chat → {@link TurnRecordNotFoundError} (the task
 *   brief's "cross-chat turnId": the caller pointed this call at the wrong chat);
 * - a terminal record for `turnId` ALREADY exists in this chat → {@link TurnAlreadyTerminalError}
 *   (idempotent refusal — "terminalizes exactly once").
 *
 * Both guards are local to the ONE target chat this call names; the multi-chat sweep that
 * decides WHICH chat/turnId pairs need terminalizing (turn-durability §7.7's full orphan
 * scan) is a caller concern (phase 6 `core`), not owned by this wrapper.
 */
export async function terminalizeTurn(deps: TransactionWrapperDeps, input: TurnTerminalizeInput) {
  const chatPath = chatJsonlPath(input.targetChatId);
  const before = readChatBefore(deps.fs, chatPath);
  if (before instanceof Error) return before;

  const hasUserRecord = before.records.some(
    (record) => record.kind === "user" && record.turnId === input.turnId,
  );
  if (!hasUserRecord)
    return new TurnRecordNotFoundError({ turnId: input.turnId, targetChatId: input.targetChatId });

  const alreadyTerminal = before.records.some((record) =>
    isTerminalRecordFor(record, input.turnId),
  );
  if (alreadyTerminal)
    return new TurnAlreadyTerminalError({ turnId: input.turnId, targetChatId: input.targetChatId });

  const appended = buildChatAppend({
    before: before.base,
    records: [input.record],
    domainIdentity: input.turnId,
    deps: deps.append,
  });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;

  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "turn",
    domain: { turnId: input.turnId, phase: "terminalization", targetChatId: input.targetChatId },
    createdAt: input.createdAt,
    operations: [
      {
        index: 0,
        target: chatPath,
        mode: "append-jsonl",
        oldImage: fileImageForBefore(before.base),
        newImage: { state: "file", sha256: after.sha256, size: after.size },
        append: appended.descriptor,
      },
    ],
  };

  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: new Map([[appended.descriptor.appendedPayloadId, appended.bytes]]),
  });
}

// ======================================================================================
// project-mutation (turn-durability §1): the base engine for every ordinary ProjectStore
// action that needs durable replace/append semantics without a dedicated top-level
// component — project creation, local-state writes, page-title edits, standalone pin
// events, and explicit JSONL repair.
// ======================================================================================

export type ProjectMutationKind =
  | "project-creation"
  | "local-state-write"
  | "title-edit"
  | "pin-event"
  | "jsonl-repair"
  // Phase-6 blocker B3's named `TransactionEngine` methods, added without disturbing any
  // already-shipped kind's meaning:
  | "chat-creation"
  | "page-reorder"
  | "page-remove";

export interface ProjectMutationInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly actionId: string;
  readonly mutationKind: ProjectMutationKind;
  /** The caller (a future higher-level `store/*` action) has already built the exact old/new images. */
  readonly operations: readonly TransactionOperation[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  readonly createdAt: string;
}

/**
 * The generic `project-mutation` wrapper. It assigns the `kind`/domain identity and runs
 * the operations through the same prepare/intent/roll-forward protocol every other wrapper
 * uses — nothing about domain validation (what makes a title edit or a repair legal) lives
 * here, matching turn-durability §1: "without introducing another top-level component".
 */
export async function runProjectMutation(
  deps: TransactionWrapperDeps,
  input: ProjectMutationInput,
) {
  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "project-mutation",
    domain: { actionId: input.actionId, mutationKind: input.mutationKind },
    createdAt: input.createdAt,
    operations: input.operations,
  };
  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: input.payloads,
  });
}

export interface StandalonePinEventInput {
  readonly pageSlug: PageSlug;
  readonly event: PinEvent;
}

/**
 * Build the one operation + payload a standalone pin event needs onto an ALREADY-EXISTING
 * comments log — ready to hand to {@link runProjectMutation} with `mutationKind: "pin-event"`.
 * Kept separate from `runProjectMutation` itself so a caller that wants to batch a pin event
 * alongside another operation in one plan still can.
 *
 * SCOPE (documented, not hidden): this never writes a comments-log HEADER — it assumes one is
 * already durable at `target` (`readPinsBefore`'s only non-error, non-`emptyBefore` path).
 * Called directly on a page with no comments log yet, it silently appends the event onto zero
 * prefix bytes with no header line at all, which `PinStore.fold`/`readPinsJsonl` then refuse
 * to open (`missing or invalid comments header`). {@link buildPinEventOperations} is the
 * header-aware entry point every new caller should use instead; this function stays exported
 * for the caller that has already proven the log exists (e.g. immediately after this same
 * function's own use).
 */
export function buildStandalonePinEventOperation(
  deps: TransactionWrapperDeps,
  input: StandalonePinEventInput,
):
  | SafeFsError
  | ChatMutationLockedError
  | Error
  | {
      readonly operation: TransactionOperation;
      readonly payloads: ReadonlyMap<string, Uint8Array>;
    } {
  const target = pageCommentsPath(input.pageSlug);
  const before = readPinsBefore(deps.fs, target);
  if (before instanceof Error) return before;
  const appended = buildPinAppend({
    before: before.base,
    events: [input.event],
    deps: deps.append,
  });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;

  return {
    operation: {
      index: 0,
      target,
      mode: "append-jsonl",
      oldImage: fileImageForBefore(before.base),
      newImage: { state: "file", sha256: after.sha256, size: after.size },
      append: appended.descriptor,
    },
    payloads: new Map([[appended.descriptor.appendedPayloadId, appended.bytes]]),
  };
}

export interface PinEventInput {
  readonly pageSlug: PageSlug;
  /** Needed only to mint a NEW comments header (storage-identity §11.2) when the log does not exist yet; ignored when it already does. */
  readonly projectId: string;
  readonly event: PinEvent;
}

/**
 * The header-aware entry point for `pin.setStatus`/standalone `pin:created` (phase-6 blocker
 * B3): when the page's comments log already exists, this is exactly
 * {@link buildStandalonePinEventOperation}'s one operation. When it does NOT — a page's very
 * first pin — this returns a single create-new `replace` of the WHOLE file (header line then
 * the event line, concatenated) instead. Deliberately NOT two operations (a header replace
 * plus a separate append) against the same target: the engine's final-state verification
 * (`engine.ts`'s `verifyRealizedOperations`) checks every operation's target against ITS OWN
 * `newImage` once roll-forward finishes, so an earlier operation's promised image would be
 * invalidated the instant a later operation on the same target grows the file further. A
 * brand-new file has no meaningful "append vs. replace" distinction — both mean "this file
 * now contains exactly these bytes" — so `replace` is the only operation this plan needs.
 */
export function buildPinEventOperations(
  deps: TransactionWrapperDeps,
  input: PinEventInput,
):
  | SafeFsError
  | ChatMutationLockedError
  | Error
  | {
      readonly operations: readonly TransactionOperation[];
      readonly payloads: ReadonlyMap<string, Uint8Array>;
    } {
  const target = pageCommentsPath(input.pageSlug);
  const existing = deps.fs.safeFs.readFile(target);
  const missing =
    existing instanceof Error && existing instanceof FsAccessError && isNotFound(existing);
  if (existing instanceof Error && !missing) return existing;

  if (!missing) {
    const built = buildStandalonePinEventOperation(deps, {
      pageSlug: input.pageSlug,
      event: input.event,
    });
    if (built instanceof Error) return built;
    return { operations: [built.operation], payloads: built.payloads };
  }

  const headerLine = encodeCommentsHeaderLine({
    kind: "pins",
    formatVersion: 1,
    projectId: input.projectId,
    pageSlug: input.pageSlug,
  });
  if (headerLine instanceof Error) return headerLine;
  const eventLine = encodePinEventLine(input.event);
  if (eventLine instanceof Error) return eventLine;

  const bytes = Buffer.concat([headerLine, eventLine]);
  const payloadId = deps.append.newPayloadId();
  const operation: TransactionOperation = {
    index: 0,
    target,
    mode: "replace",
    oldImage: { state: "absent" },
    newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
    payloadId,
  };

  return { operations: [operation], payloads: new Map([[payloadId, bytes]]) };
}

// ======================================================================================
// RestoreTransaction / ExportPublishTransaction / MigrationTransaction — INFRASTRUCTURE
// ONLY. Built and unit-tested here so the shared engine/recovery protocol (T13/T14) is
// proven for these three kinds too; MVP wires NO caller for any of them (plan "Deferred /
// cross-phase"). In particular: Restore is entirely out of MVP scope (roadmap Out-of-
// scope) — no phase-4 code path ever calls `buildRestoreTransaction`, so no
// `system:restore` record is ever written by a live path; Export's render pool and
// Migration's backup/transform machinery live in phase 6, so both builders below take
// their operations/payloads already assembled by the (not-yet-existing) caller.
// ======================================================================================

// ---- Restore (turn-durability §9) ---------------------------------------------------------

export interface RestoreTransactionInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly restoreActionId: string;
  readonly targetChatId: string;
  readonly pageSlug: PageSlug;
  /** The caller-built canonical-source replace, `releaseAfterApplied: true` (§9.1 step 5). */
  readonly sourceOperation: TransactionOperation;
  readonly sourcePayload: Uint8Array;
  readonly chatRecord: ChatSystemRestoreRecord;
  readonly createdAt: string;
}

/** `RestoreTransaction`: source replace (index 0, `releaseAfterApplied`) then the captured-chat audit append (index 1) — see the module header for the "no MVP caller" note. */
export async function buildRestoreTransaction(
  deps: TransactionWrapperDeps,
  input: RestoreTransactionInput,
) {
  const chatPath = chatJsonlPath(input.targetChatId);
  const before = readChatBefore(deps.fs, chatPath);
  if (before instanceof Error) return before;
  const appended = buildChatAppend({
    before: before.base,
    records: [input.chatRecord],
    domainIdentity: input.restoreActionId,
    deps: deps.append,
  });
  if (appended instanceof Error) return appended;
  const after = computeAfterImage({
    chunks: [before.bytes],
    beforeLength: before.base.length,
    append: appended.bytes,
  });
  if (after instanceof Error) return after;

  const chatOp: TransactionOperation = {
    index: 1,
    target: chatPath,
    mode: "append-jsonl",
    oldImage: fileImageForBefore(before.base),
    newImage: { state: "file", sha256: after.sha256, size: after.size },
    append: appended.descriptor,
  };

  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "restore",
    domain: {
      restoreActionId: input.restoreActionId,
      targetChatId: input.targetChatId,
      pageSlug: input.pageSlug,
    },
    createdAt: input.createdAt,
    operations: [{ ...input.sourceOperation, index: 0 }, chatOp],
  };

  const payloads = new Map<string, Uint8Array>([
    [appended.descriptor.appendedPayloadId, appended.bytes],
  ]);
  if (input.sourceOperation.payloadId !== undefined)
    payloads.set(input.sourceOperation.payloadId, input.sourcePayload);

  return runTransaction(deps.fs, { mutex: input.mutex, permit: input.permit, plan, payloads });
}

// ---- Export publication (turn-durability §10) ----------------------------------------------

export interface ExportPublishInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly generationId: string;
  /** Caller-ordered (§10 step 4): every new generation file, then `current.json`, then old-generation deletes. */
  readonly operations: readonly TransactionOperation[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  readonly createdAt: string;
  /** §10 step 3's re-CAS of the export source read set. */
  readonly precondition?: () => (Error | null) | Promise<Error | null>;
}

/** `ExportPublishTransaction`: a thin `kind: "export-publish"` pass-through — see the module header for scope. */
export async function buildExportPublishTransaction(
  deps: TransactionWrapperDeps,
  input: ExportPublishInput,
) {
  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "export-publish",
    domain: { generationId: input.generationId },
    createdAt: input.createdAt,
    operations: input.operations,
  };
  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: input.payloads,
    precondition: input.precondition,
  });
}

// ---- Migration (turn-durability §11) --------------------------------------------------------

export interface MigrationTransactionInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly transactionId: string;
  readonly migrationPlanId: string;
  readonly migrationActionId: string;
  readonly backupManifestDigest: Sha256Hex;
  readonly operations: readonly TransactionOperation[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  readonly createdAt: string;
  /** §11 step 6's re-CAS of every source target against the pre-backup snapshot. */
  readonly precondition?: () => (Error | null) | Promise<Error | null>;
}

/** `MigrationTransaction`: a thin `kind: "migration"` pass-through — see the module header for scope. No shipped migration exists yet (storage-identity §12), so this has no MVP caller either. */
export async function buildMigrationTransaction(
  deps: TransactionWrapperDeps,
  input: MigrationTransactionInput,
) {
  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId: input.transactionId,
    kind: "migration",
    domain: {
      migrationPlanId: input.migrationPlanId,
      migrationActionId: input.migrationActionId,
      backupManifestDigest: input.backupManifestDigest,
    },
    createdAt: input.createdAt,
    operations: input.operations,
  };
  return runTransaction(deps.fs, {
    mutex: input.mutex,
    permit: input.permit,
    plan,
    payloads: input.payloads,
    precondition: input.precondition,
  });
}

import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { DurabilityError } from "infrastructure/durability";
import { durableFileWrite, flushDir } from "infrastructure/durability";
import { sha256Hex } from "store/jsonl";
import { FsAccessError, isNotFound } from "store/safe-fs";
import type { SafeFsError, SafeProjectFs } from "store/safe-fs";

import type {
  AppliedMarker,
  CommittedMarker,
  ConflictMarker,
  FileImage,
  OperationRealized,
  ProjectWritePermit,
  Sha256Hex,
  TransactionBoundary,
  TransactionIntent,
  TransactionOperation,
  TransactionPlan,
} from "../types";
import {
  JournalCorruptError,
  JournalTooNewError,
  TRANSACTIONS_LOCAL_DIR,
  computePlanHash,
  decodePlan,
  encodeCanonicalJson,
  fileImageSchema,
  sha256HexSchema,
  validatePlanPayloads,
} from "./plan";
import { type WriteMutex, assertActivePermit } from "./write-mutex";

// ---- errors ---------------------------------------------------------------------

/** A raw filesystem operation the engine itself performs (mkdir/unlink/truncate) failed. */
export class TransactionIoError extends errore.createTaggedError({
  name: "TransactionIoError",
  message: "transaction $operation failed for $path",
}) {}

/**
 * An operation's target matches neither its planned old nor new image (turn-durability
 * §4.3 step 6 / §4.6: "Write `conflict.json`; never overwrite."). This is a LOGICAL
 * mismatch, not a physical I/O failure — the target is left exactly as observed.
 */
export class TransactionRecoveryConflictError extends errore.createTaggedError({
  name: "TransactionRecoveryConflictError",
  message: "transaction $transactionId operation $operationIndex conflict: $reason",
}) {}

/**
 * A physical write failed AFTER intent became durable (turn-durability §4.3: "An I/O error
 * after intent leaves the transaction pending and blocks overlapping project writes.").
 * Distinct from a conflict: nothing is known to be wrong with the plan, the write simply
 * did not complete. The caller may retry the same roll-forward immediately.
 */
export class TransactionIoPendingError extends errore.createTaggedError({
  name: "TransactionIoPendingError",
  message: "transaction $transactionId is pending after intent; a physical write failed: $reason",
}) {}

// ---- journal layout (turn-durability §3.1) ---------------------------------------

// Re-exported from `./plan` (which owns it, so the plan schema can refuse it as an operation
// target without closing an import cycle back to this module).
export { TRANSACTIONS_LOCAL_DIR };

export function transactionDir(transactionId: string): string {
  return `${TRANSACTIONS_LOCAL_DIR}/${transactionId}`;
}
export function planPath(transactionId: string): string {
  return `${transactionDir(transactionId)}/plan.json`;
}
export function payloadsDir(transactionId: string): string {
  return `${transactionDir(transactionId)}/payloads`;
}
export function payloadPath(transactionId: string, payloadId: string): string {
  return `${payloadsDir(transactionId)}/${payloadId}.bin`;
}
export function intentPath(transactionId: string): string {
  return `${transactionDir(transactionId)}/intent.json`;
}
export function appliedDir(transactionId: string): string {
  return `${transactionDir(transactionId)}/applied`;
}
export function appliedMarkerPath(transactionId: string, index: number): string {
  return `${appliedDir(transactionId)}/${String(index).padStart(4, "0")}.json`;
}
export function committedPath(transactionId: string): string {
  return `${transactionDir(transactionId)}/committed.json`;
}
export function conflictPath(transactionId: string): string {
  return `${transactionDir(transactionId)}/conflict.json`;
}

// ---- injected fs boundary (every impure call is a dependency) --------------------

/**
 * The impure boundary the engine needs beyond `SafeProjectFs`'s read-only surface: creating
 * journal directories, deleting a target, and the truncate-then-write-at-offset primitive
 * the JSONL append/roll-forward path uses (turn-durability §4.4). `durableWrite`/`flushDir`
 * are the already-landed `infrastructure/durability` primitives, consumed verbatim.
 */
export interface TransactionFsDeps {
  readonly safeFs: SafeProjectFs;
  readonly durableWrite: (absPath: string, bytes: Uint8Array) => DurabilityError | undefined;
  readonly flushDir: (absDir: string) => DurabilityError | undefined;
  readonly ensureDir: (absDir: string) => TransactionIoError | undefined;
  readonly deleteFile: (absPath: string) => TransactionIoError | undefined;
  /**
   * Truncate the file at `absPath` to `truncateTo` bytes, write `bytes` at `offset`, and
   * `fsync`. The caller flushes the containing directory separately (mirrors §4.2's split
   * between file-content durability and directory-metadata durability). `truncateTo` is a
   * no-op when the file is already exactly that length (the "no append started yet" case);
   * it discards a proven partial append remainder otherwise (§4.4 item 3).
   */
  readonly appendInPlace: (input: {
    absPath: string;
    truncateTo: number;
    offset: number;
    bytes: Uint8Array;
  }) => TransactionIoError | undefined;
  /** Fires immediately after each named durable artifact lands (types.ts `TransactionBoundary`). */
  readonly onBoundary?: (name: TransactionBoundary) => void;
}

/** The real Node/Windows bindings, composing the already-landed `infrastructure/durability` primitives. */
export function nodeTransactionFsDeps(safeFs: SafeProjectFs): TransactionFsDeps {
  return {
    safeFs,
    durableWrite: durableFileWrite,
    flushDir,
    ensureDir: (absDir) => {
      const made = errore.try({
        try: () => {
          fs.mkdirSync(absDir, { recursive: true });
          return undefined;
        },
        catch: (cause) => new TransactionIoError({ operation: "mkdir", path: absDir, cause }),
      });
      return made instanceof Error ? made : undefined;
    },
    deleteFile: (absPath) => {
      const removed = errore.try({
        try: () => {
          fs.unlinkSync(absPath);
          return undefined;
        },
        catch: (cause) => new TransactionIoError({ operation: "unlink", path: absPath, cause }),
      });
      return removed instanceof Error ? removed : undefined;
    },
    appendInPlace: (input) => {
      const done = errore.try({
        try: () => {
          const fd = fs.openSync(input.absPath, "r+");
          fs.ftruncateSync(fd, input.truncateTo);
          fs.writeSync(fd, input.bytes, 0, input.bytes.byteLength, input.offset);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          return undefined;
        },
        catch: (cause) =>
          new TransactionIoError({ operation: "append", path: input.absPath, cause }),
      });
      return done instanceof Error ? done : undefined;
    },
  };
}

// ---- small pure helpers -----------------------------------------------------------

function imagesEqual(a: FileImage, b: FileImage): boolean {
  if (a.state === "absent" && b.state === "absent") return true;
  if (a.state === "file" && b.state === "file") return a.sha256 === b.sha256 && a.size === b.size;
  return false;
}

/** Read a target's current realized image through `SafeProjectFs` (§5.2 type/leaf rules apply). */
function observeImage(safeFs: SafeProjectFs, relTarget: string): SafeFsError | FileImage {
  const bytes = safeFs.readFile(relTarget);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return { state: "absent" };
    return bytes;
  }
  return { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength };
}

/**
 * turn-durability §4.4: classify a JSONL target's trailing bytes against one prepared
 * append. `not-started` (exact old prefix, nothing after it), `complete` (the append fully
 * landed before acknowledgement), `leading-prefix` (a proven interrupted partial append —
 * the SOLE automatic truncation case), or `conflict` (anything else: a rewritten prefix, a
 * diverging suffix, or truncation before the recorded prefix). Exported so the recovery
 * harness (T14) can reuse the identical classification when replaying from disk.
 */
export function classifyAppendTail(input: {
  readonly currentBytes: Uint8Array;
  readonly append: {
    readonly beforeLength: number;
    readonly beforePrefixSha256: Sha256Hex;
    readonly appendedLength: number;
  };
  readonly appendBytes: Uint8Array;
}): "not-started" | "complete" | "leading-prefix" | "conflict" {
  const { currentBytes, append, appendBytes } = input;
  if (currentBytes.byteLength < append.beforeLength) return "conflict";
  const prefix = currentBytes.subarray(0, append.beforeLength);
  if (sha256Hex(prefix) !== append.beforePrefixSha256) return "conflict";

  const suffix = currentBytes.subarray(append.beforeLength);
  if (suffix.byteLength === 0) return "not-started";
  if (suffix.byteLength > appendBytes.byteLength) return "conflict";
  for (let at = 0; at < suffix.byteLength; at += 1) {
    if (suffix[at] !== appendBytes[at]) return "conflict";
  }
  return suffix.byteLength === appendBytes.byteLength ? "complete" : "leading-prefix";
}

/** The payloadId one operation refers to, whichever mode it is (or `undefined` for `delete`). */
function operationPayloadId(op: TransactionOperation): string | undefined {
  if (op.mode === "replace") return op.payloadId;
  if (op.mode === "append-jsonl") return op.append?.appendedPayloadId;
  return undefined;
}

// ---- create-new-or-already-durable installs (idempotent — this IS roll-forward) ----

/**
 * Find the deepest ancestor of `absDir` that currently exists on disk — a pure read, safe to
 * call before any write. `fs.existsSync` never throws (it swallows any stat failure and
 * reports `false`), so no errore boundary wrapping is needed here.
 */
function deepestExistingAncestor(absDir: string): string {
  let current = absDir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current; // filesystem root — nothing more to walk
    current = parent;
  }
  return current;
}

/**
 * turn-durability §4.2: "newly created directories are flushed." `deps.ensureDir`'s real
 * binding is `mkdirSync(recursive: true)`, which can silently create several missing levels
 * in one call — and durably records none of their parent dirents. This walks from the
 * deepest already-existing ancestor down to `absDir`, creating and flushing ONE level at a
 * time (each newly created directory's dirent is made durable in ITS OWN parent, mirroring
 * `recovery.ts`'s existing `flushDir(path.dirname(absDir))` after a directory removal)
 * before the next level is created. Both `ensureDir` and `flushDir` stay the already-
 * overridable `TransactionFsDeps` primitives, so a crash-injecting `flushDir` override
 * still observes every one of these flushes (blocker finding #5).
 */
function ensureDirDurable(
  deps: Pick<TransactionFsDeps, "ensureDir" | "flushDir">,
  absDir: string,
): TransactionIoError | DurabilityError | undefined {
  const existingAncestor = deepestExistingAncestor(absDir);
  if (existingAncestor === absDir) return undefined; // every component already exists

  const missing: string[] = [];
  for (let cursor = absDir; cursor !== existingAncestor; cursor = path.dirname(cursor))
    missing.unshift(cursor);

  let parent = existingAncestor;
  for (const dir of missing) {
    const made = deps.ensureDir(dir);
    if (made instanceof Error) return made;
    const flushed = deps.flushDir(parent);
    if (flushed instanceof Error) return flushed;
    parent = dir;
  }
  return undefined;
}

/**
 * Install `bytes` at a managed relative path ONLY if it is not already there. Every journal
 * record is create-new and immutable (turn-durability §3.1: "Existing records are never
 * edited in place."); treating an already-present record as already-durable rather than
 * rewriting it is what makes re-running this engine against the same `transactionId` an
 * idempotent roll-forward instead of a second, conflicting write.
 */
function installBytesIfAbsent(
  deps: TransactionFsDeps,
  relPath: string,
  bytes: Uint8Array,
): SafeFsError | DurabilityError | TransactionIoError | undefined {
  const existing = deps.safeFs.readFile(relPath);
  if (!(existing instanceof Error)) return undefined;
  if (!(existing instanceof FsAccessError && isNotFound(existing))) return existing;

  const absPath = deps.safeFs.resolve(relPath);
  if (absPath instanceof Error) return absPath;
  const ensured = ensureDirDurable(deps, path.dirname(absPath));
  if (ensured instanceof Error) return ensured;
  return deps.durableWrite(absPath, bytes);
}

/** Exported for `./journal-format.ts`'s `ensureJournalFormat` — `format.json` is a create-new, never-rewritten journal record, exactly like every marker this helper already installs. */
export function installJsonIfAbsent(
  deps: TransactionFsDeps,
  relPath: string,
  value: unknown,
): SafeFsError | DurabilityError | TransactionIoError | undefined {
  return installBytesIfAbsent(deps, relPath, encodeCanonicalJson(value));
}

// ---- marker schemas (mirrors `plan.ts`'s convention: local Zod validation per shape) ----

const appliedMarkerSchema = z.object({
  index: z.number().int().nonnegative(),
  planHash: sha256HexSchema,
  realizedImage: fileImageSchema,
});
const intentSchema = z.object({ planHash: sha256HexSchema });
const committedMarkerSchema = z.object({
  transactionId: z.string(),
  planHash: sha256HexSchema,
  operations: z.array(
    z.object({ index: z.number().int().nonnegative(), realizedImage: fileImageSchema }),
  ),
});

function readJson<T>(
  deps: TransactionFsDeps,
  relPath: string,
  schema: z.ZodType<T>,
  code: string,
): SafeFsError | JournalCorruptError | T | null {
  const bytes = deps.safeFs.readFile(relPath);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return null;
    return bytes;
  }
  // Boxed inside the `try` on purpose: a bare `unknown | Error` union collapses to `unknown`
  // and destroys the `instanceof Error` narrowing below (errore boundary rule).
  const parsed = errore.try({
    try: (): { value: unknown } => ({
      value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    }),
    catch: (cause) =>
      new JournalCorruptError({
        code: `${code}_PARSE`,
        reason: `${relPath} is not valid JSON`,
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;
  const result = schema.safeParse(parsed.value);
  if (!result.success)
    return new JournalCorruptError({
      code: `${code}_SHAPE`,
      reason: `${relPath} has an invalid shape`,
    });
  return result.data;
}

/** Read `plan.json` back and validate it (turn-durability §3.3, §4.6). Reusable by recovery (T14). */
export function readPlan(
  deps: TransactionFsDeps,
  transactionId: string,
): SafeFsError | JournalCorruptError | JournalTooNewError | TransactionPlan | null {
  const bytes = deps.safeFs.readFile(planPath(transactionId));
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return null;
    return bytes;
  }
  return decodePlan(bytes);
}

/** Read `intent.json` back, or `null` when the transaction has not reached intent (§4.1 `prepared`). */
export function readIntent(
  deps: TransactionFsDeps,
  transactionId: string,
): SafeFsError | JournalCorruptError | TransactionIntent | null {
  return readJson(deps, intentPath(transactionId), intentSchema, "INTENT");
}

/** Read `committed.json` back, or `null` when the transaction has not committed. */
export function readCommitted(
  deps: TransactionFsDeps,
  transactionId: string,
): SafeFsError | JournalCorruptError | CommittedMarker | null {
  return readJson(deps, committedPath(transactionId), committedMarkerSchema, "COMMITTED");
}

/**
 * Read every payload a plan's operations reference back off disk. Used to resume a
 * transaction in a fresh process that holds no in-memory payload bytes (T14's recovery).
 */
export function loadTransactionPayloads(
  deps: TransactionFsDeps,
  plan: TransactionPlan,
): SafeFsError | Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const op of plan.operations) {
    const payloadId = operationPayloadId(op);
    if (payloadId === undefined) continue;
    const bytes = deps.safeFs.readFile(payloadPath(plan.transactionId, payloadId));
    if (bytes instanceof Error) return bytes;
    out.set(payloadId, bytes);
  }
  return out;
}

// ---- apply one operation (turn-durability §4.3 step 6) ----------------------------

type ApplyOutcome =
  | SafeFsError
  | JournalCorruptError
  | TransactionIoError
  | DurabilityError
  | TransactionRecoveryConflictError
  | { readonly realizedImage: FileImage };

/** `replace`/`delete`: the generic old-image/new-image/neither comparison (§4.3 step 6, §4.6). */
function applyFixedOperation(input: {
  readonly deps: TransactionFsDeps;
  readonly transactionId: string;
  readonly op: TransactionOperation;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}): ApplyOutcome {
  const { deps, transactionId, op } = input;
  const current = observeImage(deps.safeFs, op.target);
  if (current instanceof Error) return current;

  if (imagesEqual(current, op.newImage)) return { realizedImage: op.newImage }; // ambiguous prior install/delete
  if (!imagesEqual(current, op.oldImage)) {
    return new TransactionRecoveryConflictError({
      transactionId,
      operationIndex: op.index,
      reason: `${op.target} matches neither its planned old nor new image`,
    });
  }

  if (op.mode === "delete") {
    const absPath = deps.safeFs.resolve(op.target);
    if (absPath instanceof Error) return absPath;
    const removed = deps.deleteFile(absPath);
    if (removed instanceof Error) return removed;
    const flushed = deps.flushDir(path.dirname(absPath));
    if (flushed instanceof Error) return flushed;
    const after = observeImage(deps.safeFs, op.target);
    if (after instanceof Error) return after;
    if (!imagesEqual(after, op.newImage)) {
      return new TransactionRecoveryConflictError({
        transactionId,
        operationIndex: op.index,
        reason: `deleting ${op.target} did not realize the planned absent image`,
      });
    }
    return { realizedImage: after };
  }

  // replace
  if (op.payloadId === undefined)
    return new JournalCorruptError({
      code: "PAYLOAD_MISSING",
      reason: `operation ${op.index} is a replace with no payloadId`,
    });
  const bytes = input.payloads.get(op.payloadId);
  if (bytes === undefined)
    return new JournalCorruptError({
      code: "PAYLOAD_MISSING",
      reason: `operation ${op.index} names payload ${op.payloadId}, which was not prepared`,
    });

  const absPath = deps.safeFs.resolve(op.target);
  if (absPath instanceof Error) return absPath;
  const ensured = ensureDirDurable(deps, path.dirname(absPath));
  if (ensured instanceof Error) return ensured;
  const written = deps.durableWrite(absPath, bytes);
  if (written instanceof Error) return written;

  const after = observeImage(deps.safeFs, op.target);
  if (after instanceof Error) return after;
  if (!imagesEqual(after, op.newImage)) {
    return new TransactionRecoveryConflictError({
      transactionId,
      operationIndex: op.index,
      reason: `replacing ${op.target} did not realize the planned new image`,
    });
  }
  return { realizedImage: after };
}

/** `append-jsonl`: the exactly-once append classification (§4.4). */
function applyAppendOperation(input: {
  readonly deps: TransactionFsDeps;
  readonly transactionId: string;
  readonly op: TransactionOperation;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}): ApplyOutcome {
  const { deps, transactionId, op } = input;
  const append = op.append;
  if (append === undefined)
    return new JournalCorruptError({
      code: "APPEND_MISSING",
      reason: `operation ${op.index} is append-jsonl with no append descriptor`,
    });

  const appendBytes = input.payloads.get(append.appendedPayloadId);
  if (appendBytes === undefined) {
    return new JournalCorruptError({
      code: "PAYLOAD_MISSING",
      reason: `operation ${op.index} names append payload ${append.appendedPayloadId}, which was not prepared`,
    });
  }

  const read = deps.safeFs.readFile(op.target);
  const missing = read instanceof Error && read instanceof FsAccessError && isNotFound(read);
  if (read instanceof Error && !missing) return read;
  const currentBytes = missing ? new Uint8Array(0) : (read as Uint8Array);
  const fileExists = !missing;

  const tail = classifyAppendTail({ currentBytes, append, appendBytes });
  if (tail === "conflict") {
    return new TransactionRecoveryConflictError({
      transactionId,
      operationIndex: op.index,
      reason: `${op.target}'s trailing bytes are neither the recorded prefix, the complete append, nor a proven partial append`,
    });
  }
  if (tail === "complete") return { realizedImage: op.newImage };

  const absPath = deps.safeFs.resolve(op.target);
  if (absPath instanceof Error) return absPath;

  if (fileExists) {
    const applied = deps.appendInPlace({
      absPath,
      truncateTo: append.beforeLength,
      offset: append.beforeLength,
      bytes: appendBytes,
    });
    if (applied instanceof Error) return applied;
    const flushed = deps.flushDir(path.dirname(absPath));
    if (flushed instanceof Error) return flushed;
  } else {
    // beforeLength === 0 is guaranteed here by the plan schema's oldImage/append consistency check.
    const ensured = ensureDirDurable(deps, path.dirname(absPath));
    if (ensured instanceof Error) return ensured;
    const written = deps.durableWrite(absPath, appendBytes);
    if (written instanceof Error) return written;
  }

  const after = observeImage(deps.safeFs, op.target);
  if (after instanceof Error) return after;
  if (!imagesEqual(after, op.newImage)) {
    return new TransactionRecoveryConflictError({
      transactionId,
      operationIndex: op.index,
      reason: `appending to ${op.target} did not realize the planned new image`,
    });
  }
  return { realizedImage: after };
}

// ---- markers ------------------------------------------------------------------

function readAppliedMarker(
  deps: TransactionFsDeps,
  transactionId: string,
  index: number,
): SafeFsError | JournalCorruptError | AppliedMarker | null {
  return readJson(
    deps,
    appliedMarkerPath(transactionId, index),
    appliedMarkerSchema,
    "APPLIED_MARKER",
  );
}

function validateExistingMarker(
  marker: AppliedMarker,
  op: TransactionOperation,
  planHash: Sha256Hex,
): JournalCorruptError | null {
  if (marker.index !== op.index)
    return new JournalCorruptError({
      code: "APPLIED_MARKER_INDEX",
      reason: `applied marker names operation ${marker.index}, expected ${op.index}`,
    });
  if (marker.planHash !== planHash)
    return new JournalCorruptError({
      code: "APPLIED_MARKER_PLAN_HASH",
      reason: `applied marker for operation ${op.index} names a different plan hash`,
    });
  if (op.releaseAfterApplied === true) return null; // a released operation's target may legitimately drift later (§9)
  if (!imagesEqual(marker.realizedImage, op.newImage)) {
    return new JournalCorruptError({
      code: "APPLIED_MARKER_IMAGE",
      reason: `applied marker for operation ${op.index} does not match its planned newImage`,
    });
  }
  return null;
}

function writeAppliedMarker(
  deps: TransactionFsDeps,
  transactionId: string,
  op: TransactionOperation,
  planHash: Sha256Hex,
  realizedImage: FileImage,
) {
  const marker: AppliedMarker = { index: op.index, planHash, realizedImage };
  const result = installJsonIfAbsent(deps, appliedMarkerPath(transactionId, op.index), marker);
  if (result instanceof Error) return result;
  deps.onBoundary?.("operation-marker-installed");
  return undefined;
}

function writeConflictMarker(
  deps: TransactionFsDeps,
  transactionId: string,
  operationIndex: number,
  reason: string,
) {
  const marker: ConflictMarker = { transactionId, operationIndex, reason };
  return installJsonIfAbsent(deps, conflictPath(transactionId), marker);
}

/** turn-durability §4.3 step 7: every non-released target must still match its realized new image. */
function verifyRealizedOperations(
  deps: TransactionFsDeps,
  plan: TransactionPlan,
): SafeFsError | TransactionRecoveryConflictError | null {
  for (const op of plan.operations) {
    if (op.releaseAfterApplied === true) continue;
    const current = observeImage(deps.safeFs, op.target);
    if (current instanceof Error) return current;
    if (!imagesEqual(current, op.newImage)) {
      return new TransactionRecoveryConflictError({
        transactionId: plan.transactionId,
        operationIndex: op.index,
        reason: `${op.target} no longer matches its realized new image at final verification`,
      });
    }
  }
  return null;
}

// ---- the physical-boundary wrapping applied only AFTER intent is durable -----------

/** After intent, a physical (non-logical) failure is `transaction_io_pending`, never silently a conflict. */
function asPostIntentFailure(
  transactionId: string,
  error:
    | SafeFsError
    | JournalCorruptError
    | TransactionIoError
    | DurabilityError
    | TransactionRecoveryConflictError,
): JournalCorruptError | TransactionRecoveryConflictError | TransactionIoPendingError {
  if (error instanceof JournalCorruptError || error instanceof TransactionRecoveryConflictError)
    return error;
  return new TransactionIoPendingError({ transactionId, reason: error.message, cause: error });
}

// ---- roll-forward: steps 6-9, reusable by recovery (T14) ---------------------------

export interface RollForwardInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly plan: TransactionPlan;
  readonly planHash: Sha256Hex;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/**
 * turn-durability §4.3 steps 6-9: apply every operation in ascending `index` order (§4.4
 * classification for `append-jsonl`), verify the complete realized state, then write
 * `committed.json`. Every mutating step re-checks the write permit (§4.5). This function
 * assumes `intent.json` is ALREADY durable — the point of no rollback has passed — so it is
 * exactly what a recovery pass (T14) resumes with for an `intended`/`applying` transaction.
 */
export async function rollForwardTransaction(deps: TransactionFsDeps, input: RollForwardInput) {
  const { plan, planHash } = input;
  const ordered = [...plan.operations].sort((a, b) => a.index - b.index);
  const realized: OperationRealized[] = [];

  for (const op of ordered) {
    const permitCheck = assertActivePermit(input.mutex, input.permit);
    if (permitCheck instanceof Error) return permitCheck;

    const existingMarker = readAppliedMarker(deps, plan.transactionId, op.index);
    if (existingMarker instanceof Error)
      return asPostIntentFailure(plan.transactionId, existingMarker);

    if (existingMarker !== null) {
      const consistent = validateExistingMarker(existingMarker, op, planHash);
      if (consistent instanceof Error) return consistent;
      realized.push({ index: op.index, realizedImage: existingMarker.realizedImage });
      continue;
    }

    const outcome =
      op.mode === "append-jsonl"
        ? applyAppendOperation({
            deps,
            transactionId: plan.transactionId,
            op,
            payloads: input.payloads,
          })
        : applyFixedOperation({
            deps,
            transactionId: plan.transactionId,
            op,
            payloads: input.payloads,
          });
    if (outcome instanceof Error) {
      if (outcome instanceof TransactionRecoveryConflictError) {
        const marked = writeConflictMarker(
          deps,
          plan.transactionId,
          op.index,
          String(outcome.reason),
        );
        if (marked instanceof Error)
          console.warn("transaction: failed to record conflict marker:", marked.message);
        return outcome;
      }
      return asPostIntentFailure(plan.transactionId, outcome);
    }
    deps.onBoundary?.("operation-target-applied");

    const markerWritten = writeAppliedMarker(
      deps,
      plan.transactionId,
      op,
      planHash,
      outcome.realizedImage,
    );
    if (markerWritten instanceof Error)
      return asPostIntentFailure(plan.transactionId, markerWritten);
    realized.push({ index: op.index, realizedImage: outcome.realizedImage });
  }

  const verified = verifyRealizedOperations(deps, plan);
  if (verified instanceof Error) return asPostIntentFailure(plan.transactionId, verified);

  const permitCheck = assertActivePermit(input.mutex, input.permit);
  if (permitCheck instanceof Error) return permitCheck;

  const committed: CommittedMarker = {
    transactionId: plan.transactionId,
    planHash,
    operations: realized,
  };
  const wroteCommitted = installJsonIfAbsent(deps, committedPath(plan.transactionId), committed);
  if (wroteCommitted instanceof Error)
    return asPostIntentFailure(plan.transactionId, wroteCommitted);
  deps.onBoundary?.("committed-installed");

  return committed;
}

// ---- the full protocol: prepare -> intent -> roll-forward (turn-durability §4.3) ----

export interface RunTransactionInput {
  readonly mutex: WriteMutex;
  readonly permit: ProjectWritePermit;
  readonly plan: TransactionPlan;
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  /** §4.3 step 4 — the domain-specific CAS re-check, run right before intent becomes durable. */
  readonly precondition?: () => (Error | null) | Promise<Error | null>;
}

function writePayloads(
  deps: TransactionFsDeps,
  transactionId: string,
  plan: TransactionPlan,
  payloads: ReadonlyMap<string, Uint8Array>,
) {
  for (const op of plan.operations) {
    const payloadId = operationPayloadId(op);
    if (payloadId === undefined) continue;
    const bytes = payloads.get(payloadId);
    if (bytes === undefined) continue; // validatePlanPayloads (called first) already guarantees presence
    const written = installBytesIfAbsent(deps, payloadPath(transactionId, payloadId), bytes);
    if (written instanceof Error) return written;
    deps.onBoundary?.("payload-installed");
  }
  return undefined;
}

/**
 * The complete `ProjectTransaction` protocol (turn-durability §4.3), in this exact order:
 * re-check the write permit, write and verify payloads, write and flush `plan.json`,
 * re-check the domain precondition, write and flush `intent.json` (the point of no
 * rollback), then {@link rollForwardTransaction} applies every operation, verifies the
 * realized state, and writes `committed.json`.
 *
 * Idempotent by construction: every journal artifact is written via a create-new-or-
 * already-durable install, so calling this again with the SAME `plan`/`payloads` (read back
 * off disk, e.g. via {@link readPlan}/{@link loadTransactionPayloads}) after an interruption
 * resumes exactly where the interruption left off.
 */
export async function runTransaction(deps: TransactionFsDeps, input: RunTransactionInput) {
  const { transactionId } = input.plan;

  // One `.do` per pre-intent step. The chain re-checks the write permit immediately before
  // each one (§4.5), so a step added later cannot forget its ownership check. A domain
  // failure travels through as a value and the `instanceof Error` guard skips the rest —
  // the chain's own `error` channel carries permit staleness alone.
  const prepared = await input.mutex
    .chain(input.permit)
    .do(() => {
      const payloadsValid = validatePlanPayloads(input.plan, input.payloads);
      if (payloadsValid instanceof Error) return payloadsValid;
      return writePayloads(deps, transactionId, input.plan, input.payloads) ?? null;
    })
    .do((prior) => {
      if (prior instanceof Error) return prior;

      const wrotePlan = installJsonIfAbsent(deps, planPath(transactionId), input.plan);
      if (wrotePlan instanceof Error) return wrotePlan;
      deps.onBoundary?.("plan-installed");

      // Confirm the durable plan re-decodes to a structurally valid plan, and derive the
      // hash over the SAME canonical bytes every later marker names (§4.3 step 3).
      const reread = deps.safeFs.readFile(planPath(transactionId));
      if (reread instanceof Error) return reread;
      const redecoded = decodePlan(reread);
      if (redecoded instanceof Error) return redecoded;

      return { plan: redecoded, planHash: computePlanHash(redecoded) };
    })
    .do(async (prior) => {
      if (prior instanceof Error) return prior;

      const preconditionResult = await (input.precondition?.() ?? null);
      if (preconditionResult instanceof Error) return preconditionResult;
      deps.onBoundary?.("precondition-checked");

      return prior;
    })
    .do((prior) => {
      if (prior instanceof Error) return prior;

      const intent: TransactionIntent = { planHash: prior.planHash };
      const wroteIntent = installJsonIfAbsent(deps, intentPath(transactionId), intent);
      if (wroteIntent instanceof Error) return wroteIntent;
      deps.onBoundary?.("intent-installed"); // the point of no rollback — no target has changed yet

      return prior;
    });

  if (prepared.error !== null) return prepared.error;
  if (prepared.result instanceof Error) return prepared.result;

  return rollForwardTransaction(deps, {
    mutex: input.mutex,
    permit: input.permit,
    plan: prepared.result.plan,
    planHash: prepared.result.planHash,
    payloads: input.payloads,
  });
}

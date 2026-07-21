import type { PreparedAppend } from "store/jsonl";

/** A lowercase-hex SHA-256 digest. Declared locally, mirroring every other module's own alias. */
export type Sha256Hex = string;

/** An OS-absolute path handed in by the composition root — never a managed relative path. */
export type AbsPath = string;

/**
 * A target file's exact realized state (turn-durability §3.3 invariant 2): either it does
 * not exist, or it is a regular file with an exact byte length and SHA-256 digest. Every
 * comparison the engine makes — "does the target still match its planned old image?" — is
 * this equality, never a timestamp or a partial read.
 */
export type FileImage =
  | { readonly state: "absent" }
  | { readonly state: "file"; readonly sha256: Sha256Hex; readonly size: number };

export type TransactionOperationMode = "replace" | "delete" | "append-jsonl";

/**
 * One planned filesystem change (turn-durability §3.3). `append` reuses `store/jsonl`'s
 * already-landed `PreparedAppend` verbatim rather than forking it.
 *
 * DIVERGENCE (documented, not silent — CLAUDE.md design/source-of-truth rule): §3.3's inline
 * TS snippet types `append.domainIdentity` as `{ field: "turnId" | "restoreActionId" |
 * "pinId"; value: string }`, but the landed `store/jsonl` append-builder types it as a plain
 * `string`. This module consumes the landed shape rather than re-forking a second one; a
 * wrapper that needs the field tag can fold it into the string (e.g. `"turnId:<uuid>"`)
 * without changing this contract.
 */
export interface TransactionOperation {
  readonly index: number;
  /** Normalized path relative to `.termcraft` (turn-durability §3.3), validated by `store/safe-fs`. */
  readonly target: string;
  readonly mode: TransactionOperationMode;
  readonly oldImage: FileImage;
  readonly newImage: FileImage;
  /** Complete new file for `replace`; omitted for `delete` and `append-jsonl`. */
  readonly payloadId?: string;
  /** Present only for `append-jsonl` — the exactly-once append descriptor (§4.4). */
  readonly append?: PreparedAppend;
  /** Restore source operation only (§9, out of MVP scope; carried for schema completeness). */
  readonly releaseAfterApplied?: boolean;
}

export type TransactionKind =
  | "turn"
  | "restore"
  | "export-publish"
  | "migration"
  | "project-mutation";

/**
 * `plan.json`'s canonical contract (turn-durability §3.3). `domain` is schema-validated by
 * `kind` in the owning wrapper (T15) — this module only carries it opaquely.
 */
export interface TransactionPlan {
  readonly journalVersion: 1;
  readonly transactionId: string;
  readonly kind: TransactionKind;
  readonly domain: Readonly<Record<string, unknown>>;
  readonly operations: readonly TransactionOperation[];
  readonly createdAt: string;
}

// ---- write-mutex (turn-durability §4.5) ----------------------------------------

/** An opaque, randomly-minted permit. `release` invalidates it for every later `isActive` check. */
export interface ProjectWritePermit {
  readonly permitId: string;
}

// ---- durable markers (turn-durability §3.1, §4.3) ------------------------------

export interface TransactionIntent {
  readonly planHash: Sha256Hex;
}

/** One operation's realized outcome, shared by its applied marker and the committed marker's roster. */
export interface OperationRealized {
  readonly index: number;
  readonly realizedImage: FileImage;
}

export interface AppliedMarker extends OperationRealized {
  readonly planHash: Sha256Hex;
}

export interface CommittedMarker {
  readonly transactionId: string;
  readonly planHash: Sha256Hex;
  readonly operations: readonly OperationRealized[];
}

export interface ConflictMarker {
  readonly transactionId: string;
  readonly operationIndex: number;
  readonly reason: string;
}

// ---- durable state machine (turn-durability §4.1) ------------------------------

/**
 * The durable transaction state, derived from which journal records exist. `record-pending`
 * is Restore-only (§9) — out of MVP scope, no writer in this module — kept here only so the
 * type names the complete state machine the spec fixes.
 */
export type TransactionState =
  | "building"
  | "prepared"
  | "intended"
  | "applying"
  | "record-pending"
  | "committed"
  | "conflict";

// ---- crash-injection boundaries (turn-durability §14.1; the T14 fault-injection substrate) --

/**
 * Named points in the engine's protocol where a durable artifact has just landed on disk.
 * `onBoundary` fires immediately after each — a fault-injection harness (T14) can terminate
 * the process there and assert recovery reaches the exact pre-intent or committed state.
 *
 * Granularity note: the spec's §14.1 list also names sub-steps of the physical 6-step install
 * (temp-file flush vs. install+parent-directory flush vs. post-write verify). Those live
 * inside `infrastructure/durability`'s `durableFileWrite`/`flushDir`, which this task
 * consumes verbatim and does not modify, so they are not independently injectable here. This
 * union fires at the artifact level — after each named journal/target write completes — which
 * is the granularity `store/transaction` owns.
 */
export type TransactionBoundary =
  | "payload-installed"
  | "plan-installed"
  | "precondition-checked"
  | "intent-installed"
  | "operation-target-applied"
  | "operation-marker-installed"
  | "committed-installed";

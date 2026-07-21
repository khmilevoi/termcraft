import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";
import { z } from "zod";

import type { DurabilityError } from "infrastructure/durability";
import { isCanonicalUuidv7 } from "infrastructure/uuid";
import { FsAccessError, isNotFound } from "store/safe-fs";
import type { SafeFsError, SafeProjectFs, StorageLimitExceededError } from "store/safe-fs";

import type {
  CommittedMarker,
  ConflictMarker,
  ProjectWritePermit,
  Sha256Hex,
  TransactionPlan,
} from "../types";
import {
  TRANSACTIONS_LOCAL_DIR,
  type TransactionFsDeps,
  TransactionIoError,
  TransactionIoPendingError,
  TransactionRecoveryConflictError,
  conflictPath,
  loadTransactionPayloads,
  nodeTransactionFsDeps,
  readCommitted,
  readIntent,
  readPlan,
  rollForwardTransaction,
  transactionDir,
} from "./engine";
import {
  JournalCorruptError,
  JournalTooNewError,
  computePlanHash,
  validatePlanPayloads,
} from "./plan";
import { type WriteMutex, WritePermitInvalidError, assertActivePermit } from "./write-mutex";

// This module implements the startup recovery scan (turn-durability §4.6; storage-identity
// §10.2): after `ProjectLease` is held and before project state is exposed, scan
// `transactions.local/` in stable lexical UUID order and CLASSIFY each journal directory
// BEFORE touching any of its targets — a target is only ever compared once the classification
// has already decided that comparison is the correct action.
//
// The scan interleaves per transaction (classify A, act on A, classify B, act on B) rather
// than classifying all journals up front. That is EQUIVALENT to a two-phase pass, and only
// because targets and journals are disjoint sets: `classifyTransaction` reads nothing but
// files under `transactions.local/{id}/`, and `./plan.ts`'s schema refuses any operation whose
// target names the journal namespace. So acting on A cannot alter what B classifies as. If
// that target guard is ever relaxed, this loop must be split into a full classify pass
// followed by a separate act pass — the ordering guarantee depends on it.
//
// `classifyTransaction` is the pure
// (read-only) decision; `recoverOneTransaction`/`recoverTransactions` perform the action the
// classification names, reusing `./engine`'s already-landed `rollForwardTransaction` verbatim
// for the roll-forward branch (its own §4.3 step 6 / §4.4 logic already implements the full
// old/new/neither and JSONL prefix/complete/leading-prefix/conflict decision table — this
// module does not reimplement it, only decides WHICH transactions reach it and in what order).

// ---- the "discard" capability recovery needs beyond `TransactionFsDeps` -----------

/**
 * `TransactionFsDeps` (`./engine`) has no whole-directory removal — the engine itself never
 * deletes a transaction directory, only files inside one. Recovery's "discard" action
 * (turn-durability §4.6: "Delete the uncommitted transaction directory; targets are
 * untouched by contract") needs exactly one more primitive, so it is added here rather than
 * by editing `./engine` (T13's file, consumed verbatim per this task's brief).
 */
export interface RecoveryFsDeps extends TransactionFsDeps {
  /** Recursively remove an already-`SafeProjectFs`-resolved transaction directory. */
  readonly removeTransactionDir: (absDir: string) => TransactionIoError | undefined;
}

/** The real Node/Bun binding, composing `./engine`'s already-landed `nodeTransactionFsDeps` verbatim. */
export function nodeRecoveryFsDeps(safeFs: SafeProjectFs): RecoveryFsDeps {
  return {
    ...nodeTransactionFsDeps(safeFs),
    removeTransactionDir: (absDir) => {
      const removed = errore.try({
        try: () => {
          fs.rmSync(absDir, { recursive: true });
          return undefined;
        },
        catch: (cause) => new TransactionIoError({ operation: "rm", path: absDir, cause }),
      });
      return removed instanceof Error ? removed : undefined;
    },
  };
}

// ---- listing (stable lexical UUID order) -----------------------------------------

/**
 * List every transaction directory under `transactions.local/`, sorted in stable lexical
 * order (storage-identity §10.2: "scans transactions.local/ in stable lexical UUID order").
 * A missing directory (no transaction has ever been prepared) is an empty list, not an
 * error. A non-UUID entry is not a shape this engine ever writes; it is skipped rather than
 * failing the whole scan, but the skip is logged — never a silent swallow (errore rule).
 */
export function listTransactionIds(deps: TransactionFsDeps): SafeFsError | readonly string[] {
  const names = deps.safeFs.list(TRANSACTIONS_LOCAL_DIR);
  if (names instanceof Error) {
    if (names instanceof FsAccessError && isNotFound(names)) return [];
    return names;
  }

  const ids: string[] = [];
  for (const name of names) {
    if (isCanonicalUuidv7(name)) {
      ids.push(name);
      continue;
    }
    // `format.json` (`./journal-format.ts`, §3.1) is a KNOWN, expected sibling of every
    // transaction directory, not an anomaly — skip it quietly rather than warning on every
    // ordinary launch.
    if (name === "format.json") continue;
    console.warn(
      `store/transaction recovery: skipping non-UUID entry under ${TRANSACTIONS_LOCAL_DIR}/: ${name}`,
    );
  }
  return ids.sort();
}

// ---- conflict.json (not exported by `./engine`) -----------------------------------

const conflictMarkerSchema = z.object({
  transactionId: z.string(),
  operationIndex: z.number().int().nonnegative(),
  reason: z.string(),
});

/** Read `conflict.json` back, or `null` when this transaction never reached a recovery conflict. */
function readConflictMarker(
  deps: TransactionFsDeps,
  transactionId: string,
): SafeFsError | JournalCorruptError | ConflictMarker | null {
  const bytes = deps.safeFs.readFile(conflictPath(transactionId));
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
        code: "CONFLICT_PARSE",
        reason: `${conflictPath(transactionId)} is not valid JSON`,
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;
  const result = conflictMarkerSchema.safeParse(parsed.value);
  if (!result.success)
    return new JournalCorruptError({
      code: "CONFLICT_SHAPE",
      reason: `${conflictPath(transactionId)} has an invalid shape`,
    });
  if (result.data.transactionId !== transactionId) {
    return new JournalCorruptError({
      code: "CONFLICT_IDENTITY",
      reason: `conflict.json under ${transactionId}/ names a different transactionId`,
    });
  }
  return result.data;
}

/** Read every payload a plan's operations reference and verify each against its declared hash/length (§4.6 "missing payload, or payload hash mismatch") and every operation's namespace size limit (§5.3 "fails before intent"). */
function loadValidatedPayloads(
  deps: TransactionFsDeps,
  plan: TransactionPlan,
): JournalCorruptError | StorageLimitExceededError | SafeFsError | Map<string, Uint8Array> {
  const loaded = loadTransactionPayloads(deps, plan);
  if (loaded instanceof Error) {
    if (loaded instanceof FsAccessError && isNotFound(loaded)) {
      return new JournalCorruptError({
        code: "PAYLOAD_MISSING",
        reason: `${plan.transactionId} references a payload that is not on disk`,
      });
    }
    return loaded;
  }
  const valid = validatePlanPayloads(plan, loaded);
  if (valid instanceof Error) return valid;
  return loaded;
}

// ---- classification (turn-durability §4.6; storage-identity §10.2) ----------------

export type TransactionClassification =
  | { readonly kind: "discard"; readonly transactionId: string }
  | {
      readonly kind: "roll-forward";
      readonly transactionId: string;
      readonly plan: TransactionPlan;
      readonly planHash: Sha256Hex;
      readonly payloads: ReadonlyMap<string, Uint8Array>;
    }
  | {
      readonly kind: "complete";
      readonly transactionId: string;
      readonly committed: CommittedMarker;
    }
  | {
      readonly kind: "conflict";
      readonly transactionId: string;
      readonly conflict: ConflictMarker;
    };

export type ClassifyError =
  | SafeFsError
  | JournalCorruptError
  | JournalTooNewError
  | StorageLimitExceededError;

/**
 * Classify one `transactions.local/{transactionId}/` directory into exactly one of the four
 * §10.2 branches, WITHOUT reading or comparing any managed target. `plan.json` is read
 * first — every later marker (`intent.json`, `committed.json`) names a plan hash, so a plan
 * that cannot be trusted (missing, corrupt, or from a newer binary) makes every marker that
 * references it untrustworthy too.
 *
 * Precedence, most authoritative first: a valid `committed.json` means complete regardless
 * of anything else (§10.2: "recognize the domain action as complete and do not compare
 * targets that may have legitimately changed later" — this exemption covers targets only,
 * so `committed.planHash` is still checked against the plan for identity, but no operation's
 * realized image is re-observed). A valid `conflict.json` re-presents the same conflict. A
 * valid `intent.json` rolls forward. Otherwise a valid plan and payloads with neither marker
 * discards the prepared-but-uncommitted journal.
 */
export function classifyTransaction(
  deps: TransactionFsDeps,
  transactionId: string,
): ClassifyError | TransactionClassification {
  const plan = readPlan(deps, transactionId);
  if (plan instanceof Error) return plan; // JournalCorruptError | JournalTooNewError | SafeFsError

  const planHash = plan === null ? null : computePlanHash(plan);

  const committed = readCommitted(deps, transactionId);
  if (committed instanceof Error) return committed;
  if (committed !== null) {
    if (plan === null || planHash === null) {
      return new JournalCorruptError({
        code: "COMMITTED_WITHOUT_PLAN",
        reason: `${transactionId} has committed.json but no plan.json`,
      });
    }
    if (committed.planHash !== planHash) {
      return new JournalCorruptError({
        code: "COMMITTED_PLAN_HASH",
        reason: `${transactionId}'s committed.json names a plan hash that does not match its plan.json`,
      });
    }
    return { kind: "complete", transactionId, committed };
  }

  const conflict = readConflictMarker(deps, transactionId);
  if (conflict instanceof Error) return conflict;
  if (conflict !== null) return { kind: "conflict", transactionId, conflict };

  const intent = readIntent(deps, transactionId);
  if (intent instanceof Error) return intent;
  if (intent !== null) {
    if (plan === null || planHash === null) {
      return new JournalCorruptError({
        code: "INTENT_WITHOUT_PLAN",
        reason: `${transactionId} has intent.json but no plan.json`,
      });
    }
    if (intent.planHash !== planHash) {
      return new JournalCorruptError({
        code: "INTENT_PLAN_HASH",
        reason: `${transactionId}'s intent.json names a plan hash that does not match its plan.json`,
      });
    }
    const payloads = loadValidatedPayloads(deps, plan);
    if (payloads instanceof Error) return payloads;
    return { kind: "roll-forward", transactionId, plan, planHash, payloads };
  }

  // No committed, conflict, or intent marker. A `null` plan means nothing was ever written
  // durably for this transactionId (turn-durability §4.1 `building`) — there is nothing to
  // roll forward or compare, so it degrades to the same "discard" action as a fully prepared
  // but never-intended journal. Otherwise the plan and its payloads must both be valid for
  // the discard to be authorized (§4.6 row 1's "invalid plan... missing payload... hash
  // mismatch" still applies even though nothing downstream of them will be used).
  if (plan === null) return { kind: "discard", transactionId };
  const payloads = loadValidatedPayloads(deps, plan);
  if (payloads instanceof Error) return payloads;
  return { kind: "discard", transactionId };
}

// ---- acting on one classification --------------------------------------------------

export interface RecoveredTransaction {
  readonly transactionId: string;
  readonly action: "discarded" | "rolled-forward" | "already-complete";
}

export type RecoverOneError =
  | WritePermitInvalidError
  | TransactionIoError
  | DurabilityError
  | SafeFsError
  | JournalCorruptError
  | TransactionRecoveryConflictError
  | TransactionIoPendingError;

async function recoverOneTransaction(
  deps: RecoveryFsDeps,
  mutex: WriteMutex,
  permit: ProjectWritePermit,
  classification: Exclude<TransactionClassification, { kind: "conflict" }>,
): Promise<RecoverOneError | RecoveredTransaction> {
  if (classification.kind === "complete") {
    return { transactionId: classification.transactionId, action: "already-complete" };
  }

  const permitCheck = assertActivePermit(mutex, permit);
  if (permitCheck instanceof Error) return permitCheck;

  if (classification.kind === "discard") {
    const absDir = deps.safeFs.resolve(transactionDir(classification.transactionId));
    if (absDir instanceof Error) return absDir;
    const removed = deps.removeTransactionDir(absDir);
    if (removed instanceof Error) return removed;
    // Durably persist the removal itself: a crash right after `rmSync` but before this
    // flush just re-discards the same (already half-gone) directory on the next scan —
    // still safe, since discard never depends on prior partial state.
    const flushed = deps.flushDir(path.dirname(absDir));
    if (flushed instanceof Error) return flushed;
    return { transactionId: classification.transactionId, action: "discarded" };
  }

  // roll-forward: `./engine`'s already-landed protocol owns every remaining decision —
  // old/new/neither image comparison and the full JSONL append tail classification.
  const result = await rollForwardTransaction(deps, {
    mutex,
    permit,
    plan: classification.plan,
    planHash: classification.planHash,
    payloads: classification.payloads,
  });
  if (result instanceof Error) return result;
  return { transactionId: classification.transactionId, action: "rolled-forward" };
}

// ---- the full startup scan ----------------------------------------------------------

export type RecoveryOutcome =
  | {
      readonly ok: true;
      readonly recovered: number;
      readonly discarded: number;
      readonly alreadyComplete: number;
    }
  | {
      readonly ok: false;
      readonly transactionId: string;
      readonly error: ClassifyError | RecoverOneError;
    };

/**
 * The complete startup recovery pass (turn-durability §4.6; storage-identity §10.2): scan
 * `transactions.local/` in lexical order, classify each transaction directory before
 * touching any target, and act on the classification. Transactions sorting BEFORE a stop
 * condition (an invalid journal, or a conflict — freshly detected or a pre-existing
 * `conflict.json`) are still durably discarded/rolled-forward/recognized; the scan then
 * halts and reports that one stop condition, matching "Conflict marker exists → re-present
 * the same conflict before Workspace" and journal_corrupt's "write nothing" — for THAT
 * transaction only, since nothing about an already-resolved sibling transaction is placed
 * in doubt by a later one being unreadable or conflicted.
 *
 * JUDGMENT CALL (spec gap, documented per CLAUDE.md): neither turn-durability §4.6 nor
 * storage-identity §10.2 states explicitly whether the scan continues past one bad/conflicted
 * transaction to process later ones, or halts the whole pass immediately. This chooses
 * "process everything safe first, then stop and report the first unresolved one" because
 * every action taken before the stop (discard, roll-forward, recognize-complete) is
 * independently idempotent and already durable, so taking it can never be wrong regardless
 * of what a later, unrelated transaction turns out to be.
 */
export async function recoverTransactions(
  deps: RecoveryFsDeps,
  mutex: WriteMutex,
  permit: ProjectWritePermit,
): Promise<RecoveryOutcome> {
  const permitCheck = assertActivePermit(mutex, permit);
  if (permitCheck instanceof Error) return { ok: false, transactionId: "", error: permitCheck };

  const ids = listTransactionIds(deps);
  if (ids instanceof Error) return { ok: false, transactionId: "", error: ids };

  let recovered = 0;
  let discarded = 0;
  let alreadyComplete = 0;

  for (const transactionId of ids) {
    const classification = classifyTransaction(deps, transactionId);
    if (classification instanceof Error) return { ok: false, transactionId, error: classification };

    if (classification.kind === "conflict") {
      const conflictError = new TransactionRecoveryConflictError({
        transactionId,
        operationIndex: classification.conflict.operationIndex,
        reason: classification.conflict.reason,
      });
      return { ok: false, transactionId, error: conflictError };
    }

    const acted = await recoverOneTransaction(deps, mutex, permit, classification);
    if (acted instanceof Error) return { ok: false, transactionId, error: acted };

    if (acted.action === "discarded") discarded += 1;
    else if (acted.action === "rolled-forward") recovered += 1;
    else alreadyComplete += 1;
  }

  return { ok: true, recovered, discarded, alreadyComplete };
}

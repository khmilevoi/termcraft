import type { FailureDtoV1 } from "core/protocol";
import { PagesManifestInvalidError } from "entities/design-tree";
import { log } from "infrastructure/debug-log";
import { JsonlMidFileCorruptionError } from "store/jsonl";
import { LeaseHeldError, LeaseIoError, LeaseUnavailableError } from "store/lease";
import { MigrationBackupFailedError, MigrationStaleError } from "store/migration";
import { DesignTreeTooDeepError, PageEntryNotFoundError } from "store/model/design-tree-store";
import {
  EntrySourceDriftedError,
  JsonlOpenError,
  ManifestDriftedError,
  ReorderPagesInvalidOrderError,
} from "store/model/factory";
import {
  DiagnosticsStoreIoError,
  PageMetaCacheIoError,
  RenderCacheIoError,
} from "store/projections";
import {
  FsAccessError,
  IdentityChangedError,
  LeafRejectedError,
  NameCollisionError,
  PathEscapeError,
  PathRuleError,
  ReparsePointRejectedError,
  StorageLimitExceededError,
  UnknownNamespaceError,
  UnsafeHardlinkError,
  WorkspaceChangedDuringSnapshotError,
} from "store/safe-fs";
import { InvalidIdentityError, TurnJsonWriteError, WorkspaceCollisionError } from "store/sandbox";
import { ManifestCorruptError, ManifestTooNewError } from "store/toml";
import {
  ChatMutationLockedError,
  JournalCorruptError,
  SourceChangedError,
  StaleError,
  TransactionIoPendingError,
  TransactionRecoveryConflictError,
  TurnAlreadyTerminalError,
  TurnFinalizeInputError,
  TurnRecordNotFoundError,
} from "store/transaction";
import { TrustLedgerError, TrustSubjectError } from "store/trust";

// The one `FailureDtoV1` mapper every adapter in this ring uses (Task 1, "shared error map").
// Every store tagged error narrows via `instanceof`, per the plan's mapping table
// (2026-07-24-adapter-ring.md, Task 1). Every recognized class gets its own `instanceof`
// check — an error that falls through to the final "unclassified" branch prints a
// `console.warn` (errore rule 21), so a KNOWN store error must never reach it, or an
// ordinary, expected failure path would add new stderr noise to every test that exercises it.

function safeMessageOf(error: Error): string {
  // Bounded, path-free display text (kernel-command-contract §11.2's "safe display message").
  // `error.message` on every tagged error here is already a short, parameterized template
  // (errore's `createTaggedError`) — never a raw stack trace or an absolute filesystem path.
  return error.message;
}

/**
 * `SourceChangedError.part` (`store/transaction/model/wrappers.ts`) is a finer grain than
 * `FailureDtoV1`'s closed `part: "page" | "manifest"` for this code
 * (`core/protocol/model/failure.ts`), so it is narrowed here with the finer fact preserved as
 * an extra bounded detail key.
 *
 * CORRECTED (assigned during task-14 review round 1; the drift landed in `ffd1429`, an
 * ancestor of task 14's own base). This matched `` `canonical:${slug}` ``, which
 * `wrappers.ts` STOPPED constructing when the design tree replaced canonical page files: the
 * one live site (`wrappers.ts:590`) now builds `` `design:${treeRelPath}` ``. Verified by
 * grep: `part: \`canonical:` has ZERO construction sites and `part: \`design:` has exactly
 * one. So every CAS drift on a tree file took the fallback below — losing the detail entirely
 * AND emitting a `console.warn` on an ORDINARY failure path, which this file's own header
 * forbids ("a KNOWN store error must never reach it, or an ordinary, expected failure path
 * would add new stderr noise to every test that exercises it").
 *
 * THE DETAIL KEY IS `relPath`, NOT `slug`. `design:<treeRelPath>` carries a TREE-RELATIVE
 * PATH; `design/pages.json` binds slugs to paths and that mapping is not invertible here — a
 * path is not a slug and must never be written into a field named one, which is precisely what
 * a naive `startsWith("design:") -> slug` would have done. `EntrySourceDriftedError` below
 * still reports a genuine `slug`, because it genuinely has one.
 */
function normalizeSourceChangedPart(raw: string | number): {
  readonly part: "page" | "manifest";
  readonly relPath?: string;
} {
  const text = String(raw);
  if (text === "manifest") return { part: "manifest" };
  if (text.startsWith("design:")) return { part: "page", relPath: text.slice("design:".length) };
  log.warn(
    `store/adapters: SourceChangedError.part "${text}" matched neither "manifest" nor "design:<treeRelPath>"; defaulting to "page"`,
  );
  return { part: "page" };
}

/** The identical `StaleError.part` mismatch as {@link normalizeSourceChangedPart}: `"chat"` or `` `pins:${slug}` `` narrows to `FailureDtoV1`'s closed `part: "chat" | "pins"`. */
function normalizeStalePart(raw: string | number): {
  readonly part: "chat" | "pins";
  readonly slug?: string;
} {
  const text = String(raw);
  if (text === "chat") return { part: "chat" };
  if (text.startsWith("pins:")) return { part: "pins", slug: text.slice("pins:".length) };
  log.warn(
    `store/adapters: StaleError.part "${text}" matched neither "chat" nor "pins:<slug>"; defaulting to "pins"`,
  );
  return { part: "pins" };
}

/**
 * Every `SafeFsError`/`StagingError` member EXCEPT `StorageLimitExceededError` (which gets
 * its own `RESOURCE_LIMIT_EXCEEDED` code, checked separately) — a namespace classification
 * fault (`UnknownNamespaceError`) is the same "generic durable-read/write fault" as every
 * sibling on this list.
 */
function isGenericFsFamilyError(error: Error): boolean {
  return (
    error instanceof PathRuleError ||
    error instanceof NameCollisionError ||
    error instanceof UnknownNamespaceError ||
    error instanceof LeafRejectedError ||
    error instanceof UnsafeHardlinkError ||
    error instanceof IdentityChangedError ||
    error instanceof ReparsePointRejectedError ||
    error instanceof PathEscapeError ||
    error instanceof WorkspaceChangedDuringSnapshotError ||
    error instanceof FsAccessError
  );
}

/** The three `StagingError`-only members not already covered by {@link isGenericFsFamilyError}. */
function isStagingOnlyError(error: Error): boolean {
  return (
    error instanceof WorkspaceCollisionError ||
    error instanceof InvalidIdentityError ||
    error instanceof TurnJsonWriteError
  );
}

/** `TrustError = TrustSubjectError | TrustLedgerError` (`store/trust`). */
function isTrustError(error: Error): boolean {
  return error instanceof TrustSubjectError || error instanceof TrustLedgerError;
}

/** `LeaseError = LeaseHeldError | LeaseUnavailableError | LeaseIoError` (`store/lease`). */
function isLeaseError(error: Error): boolean {
  return (
    error instanceof LeaseHeldError ||
    error instanceof LeaseUnavailableError ||
    error instanceof LeaseIoError
  );
}

/**
 * `ProjectionsError = PageMetaCacheIoError | DiagnosticsStoreIoError | RenderCacheIoError`
 * (`store/projections`). FLAGGED (plan Task 1 table): the table pairs "`ProjectionsError`
 * (quota)" with `StorageLimitExceededError` under `RESOURCE_LIMIT_EXCEEDED`, but the landed
 * `store/projections` classes carry no quota-specific discriminator at all — each is a
 * generic `{operation: "read"|"write"|"list"|"mkdir", path, cause}` IO fault, and quota
 * enforcement in that submodule is silent LRU eviction, never a failure return (verified
 * against `page-meta-cache.ts`/`diagnostics-store.ts`/`render-cache.ts`: `enforceQuota` never
 * returns an error). There is no honest way to distinguish "this IO fault was actually a
 * quota event" from an ordinary read/write fault with the shape these classes carry, so all
 * three map to the same generic `PERSISTENCE_FAILED` every other durable-fault class here
 * gets — not a guessed `RESOURCE_LIMIT_EXCEEDED`.
 */
function isProjectionsError(error: Error): boolean {
  return (
    error instanceof PageMetaCacheIoError ||
    error instanceof DiagnosticsStoreIoError ||
    error instanceof RenderCacheIoError
  );
}

/**
 * Maps a store tagged error onto the closed v1 `FailureDtoV1` registry
 * (`core/protocol`'s `OPERATIONAL_FAILURE_CODES_V1`) per the plan's Task 1 table. Every
 * store adapter in this ring uses this one function — no adapter maps a store error onto a
 * `FailureDtoV1` by hand. Not itself a port implementation: no `AssertConforms` line.
 */
export function toFailureDto(error: Error): FailureDtoV1 {
  if (error instanceof StorageLimitExceededError) {
    return {
      code: "RESOURCE_LIMIT_EXCEEDED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  if (error instanceof SourceChangedError) {
    const normalized = normalizeSourceChangedPart(error.part);
    return {
      code: "APPLY_SOURCE_CHANGED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details:
        normalized.relPath === undefined
          ? { part: normalized.part }
          : { part: normalized.part, relPath: normalized.relPath },
    };
  }

  if (error instanceof StaleError) {
    const normalized = normalizeStalePart(error.part);
    return {
      code: "APPLY_STALE",
      retryable: false,
      safeMessage: safeMessageOf(error),
      // `slug`, not `relPath`: `StaleError.part`'s finer grain is `pins:<slug>`, which really
      // is a page slug — unlike `SourceChangedError`'s `design:<treeRelPath>`. See
      // {@link normalizeSourceChangedPart} for why the two keys must stay distinct.
      details:
        normalized.slug === undefined
          ? { part: normalized.part }
          : { part: normalized.part, slug: normalized.slug },
    };
  }

  if (error instanceof TransactionRecoveryConflictError) {
    return {
      code: "TRANSACTION_RECOVERY_CONFLICT",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  if (error instanceof TransactionIoPendingError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: true,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  if (error instanceof MigrationStaleError) {
    return {
      code: "MIGRATION_STALE",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  if (error instanceof MigrationBackupFailedError) {
    return {
      code: "MIGRATION_BACKUP_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `design/pages.json` itself (`entities/design-tree`'s `decodePagesManifest`) is invalid —
   * bad JSON, an unknown field, a duplicate slug, a malformed `entry`, or a
   * `requestedActivePage` naming an unlisted slug (design §4's fatal list). Same generic
   * durable-read fault as `ManifestCorruptError` just above; the closed v1 union has no
   * dedicated "design manifest invalid" code.
   */
  if (error instanceof PagesManifestInvalidError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `DesignTreeStore.listTree()` (`store/model/design-tree-store.ts`, design-tree canonical
   * source plan Task 9): `design/` nests deeper than the `design-source` namespace's own depth
   * ceiling. A refusal, not a corruption — but the closed v1 union has no dedicated
   * "tree too deep" code, so it folds to the same generic durable-fault bucket.
   */
  if (error instanceof DesignTreeTooDeepError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `DesignTreeStore.readSource()` (Task 9): `design/pages.json` lists no entry for the
   * requested page slug — never a slug-computed path guess (design §3, §7). A legitimate,
   * expected outcome (an unlisted/stale slug), not itself a bug, but the closed v1 union has
   * no dedicated "no entry for this slug" code either.
   */
  if (error instanceof PageEntryNotFoundError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `TransactionEngine.reorderPages()` (Task 9): `orderedSlugs` is not an exact permutation
   * of the manifest's own slugs — a subset, a superset, or a duplicate (`PageMutations.reorder`'s
   * own port doc). A caller-input validation failure, mapped the same way `TurnFinalizeInputError`
   * above is: the closed v1 union has no dedicated "invalid input" code.
   */
  if (error instanceof ReorderPagesInvalidOrderError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `TransactionEngine.reorderPages()`/`removePage()` (Task 9 review round 3, correcting
   * round 2's own mis-mapping): `design/pages.json` drifted between the caller's
   * `manifestBefore` read and the write permit — a genuine CAS-style conflict
   * (`ManifestDriftedError`'s own doc comment, `store/model/factory.ts`), the SAME shape
   * `SourceChangedError` above already has a dedicated code for: "the manifest moved under
   * you, re-read and retry." Mapped to the identical `APPLY_SOURCE_CHANGED`/`part: "manifest"`
   * rather than the generic `PERSISTENCE_FAILED` bucket round 2 used — that bucket tells the
   * UI nothing about WHY the write failed, where `APPLY_SOURCE_CHANGED` is the exact,
   * already-closed-v1 code for this exact condition.
   */
  if (error instanceof ManifestDriftedError) {
    return {
      code: "APPLY_SOURCE_CHANGED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: { part: "manifest" },
    };
  }

  /**
   * `TransactionEngine.renamePageTitle()` (Task 9 review round 3): the entry file's own
   * bytes, or `design/pages.json`'s binding for the page, drifted between the caller's
   * observation and the write permit (`EntrySourceDriftedError`'s own doc comment,
   * `store/model/factory.ts`) — the identical CAS-conflict shape as `ManifestDriftedError`
   * just above, scoped to one page's own entry rather than the whole manifest, so it maps to
   * the same `APPLY_SOURCE_CHANGED` code with `part: "page"`. It reports `slug` (not
   * `relPath`, as `normalizeSourceChangedPart`'s `design:<treeRelPath>` case does) because
   * this error genuinely carries a page slug — see that function's own doc for why the two
   * keys are deliberately different facts.
   */
  if (error instanceof EntrySourceDriftedError) {
    return {
      code: "APPLY_SOURCE_CHANGED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: { part: "page", slug: error.pageSlug },
    };
  }

  // FLAGGED (plan Task 1 table): "candidate for MIGRATION_STALE; confirm the §11.2 semantic
  // before finalizing." Implemented literally as the plan's table states (`PERSISTENCE_FAILED`)
  // pending that confirmation — not silently upgraded to `MIGRATION_STALE` on a guess.
  if (error instanceof ManifestTooNewError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  if (
    isGenericFsFamilyError(error) ||
    isStagingOnlyError(error) ||
    isTrustError(error) ||
    isLeaseError(error) ||
    isProjectionsError(error) ||
    error instanceof JsonlOpenError ||
    error instanceof JournalCorruptError ||
    error instanceof ManifestCorruptError
  ) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `JsonlMidFileCorruptionError` (`store/jsonl`) is the raw valid-prefix reader's hard
   * corruption fault (storage-identity §11.3 case 3) — the same failure family as
   * `JournalCorruptError`/`ManifestCorruptError` just above, only reached through the
   * direct reader (`chat-store.readAppendBase`, `session-checkpoint`,
   * `pin-store.readRawEvents`) instead of the factory-level `open()` wrapper
   * (`JsonlOpenError`). Same generic durable-read fault, same code.
   */
  if (error instanceof JsonlMidFileCorruptionError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `ChatMutationLockedError` (`store/transaction`): a chat or comments log's tail is not
   * `clean` and an explicit repair is required before another append (`wrappers.ts`'s own
   * header). A durable-write fault of the same generic shape as every other
   * `PERSISTENCE_FAILED` class above — the closed union has no distinct "locked, needs
   * repair" code.
   */
  if (error instanceof ChatMutationLockedError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `TurnFinalizeInputError` (`store/transaction`): the caller handed `finalizeTurn` a
   * finalization input it cannot turn into a plan (e.g. a `replace` page op with no
   * bytes — `wrappers.ts`'s own header). The closed v1 union (`failure.ts:10-41`) has no
   * dedicated "invalid input" code, so — like `ManifestTooNewError` above — this folds to
   * the general bounded storage/process/queue fault §11.2 assigns `PERSISTENCE_FAILED`,
   * rather than a guessed, more specific code.
   */
  if (error instanceof TurnFinalizeInputError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `TurnRecordNotFoundError` (`store/transaction`): `terminalizeTurn`/orphan recovery was
   * asked to terminalize a `turnId` with no `user` record in the target chat —
   * turn-durability §7.7 classifies "terminal record without its user record" (and the
   * cross-chat variant this class documents) as `chat_corrupt`. The closed v1 code union
   * has no dedicated `chat_corrupt` code, and this is a distinct fault from
   * `TransactionRecoveryConflictError` (kernel-command-contract §11.2: "durable
   * roll-forward cannot prove a safe operation" — a roll-forward-machinery concern, not a
   * data-integrity mismatch the wrapper's own business logic found), so it takes the
   * general `PERSISTENCE_FAILED` bucket rather than reusing that differently-scoped code.
   */
  if (error instanceof TurnRecordNotFoundError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  /**
   * `TurnAlreadyTerminalError` (`store/transaction`): `turnId` already has a terminal
   * record in the target chat. Turn-durability §7.7 documents this as an INTENTIONAL
   * idempotent no-op — repeated orphan-scan terminalization of the same turn is expected
   * to hit this every time after the first, per this class's own doc comment ("this is
   * what makes repeated orphan-scan terminalization idempotent"). It is not a transient
   * fault worth retrying, and the closed v1 union has no "already done, nothing to do"
   * code. `PERSISTENCE_FAILED` with `retryable: false` is the most faithful EXISTING code
   * available — chosen deliberately over inventing a new one (forbidden) or reusing
   * `TRANSACTION_RECOVERY_CONFLICT`, which names a different concern (durable
   * roll-forward safety, not an idempotent already-terminal state).
   */
  if (error instanceof TurnAlreadyTerminalError) {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: safeMessageOf(error),
      details: {},
    };
  }

  // An unmapped store error at this boundary is a bug to surface, not swallow (errore rule 21).
  log.warn("store/adapters: unmapped store error folded to PERSISTENCE_FAILED:", error);
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: safeMessageOf(error),
    details: {},
  };
}

import type { FailureDtoV1 } from "core/protocol";
import { LeaseHeldError, LeaseIoError, LeaseUnavailableError } from "store/lease";
import { MigrationBackupFailedError, MigrationStaleError } from "store/migration";
import { JsonlOpenError } from "store/model/factory";
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
  JournalCorruptError,
  SourceChangedError,
  StaleError,
  TransactionIoPendingError,
  TransactionRecoveryConflictError,
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
 * `SourceChangedError.part` (`store/transaction/model/wrappers.ts`) is constructed with
 * `"manifest"` or `` `canonical:${slug}` `` (verified against every construction site in that
 * file) — a finer grain than `FailureDtoV1`'s closed `part: "page" | "manifest"` for this code
 * (`core/protocol/model/failure.ts`). This is a genuine signature mismatch, not a guess: the
 * `canonical:<slug>` case IS the "a canonical page drifted" case §11.2 calls `"page"`, so it
 * normalizes to `"page"` with the slug preserved as an extra bounded detail key.
 */
function normalizeSourceChangedPart(raw: string | number): {
  readonly part: "page" | "manifest";
  readonly slug?: string;
} {
  const text = String(raw);
  if (text === "manifest") return { part: "manifest" };
  if (text.startsWith("canonical:")) return { part: "page", slug: text.slice("canonical:".length) };
  console.warn(
    `store/adapters: SourceChangedError.part "${text}" matched neither "manifest" nor "canonical:<slug>"; defaulting to "page"`,
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
  console.warn(
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
        normalized.slug === undefined
          ? { part: normalized.part }
          : { part: normalized.part, slug: normalized.slug },
    };
  }

  if (error instanceof StaleError) {
    const normalized = normalizeStalePart(error.part);
    return {
      code: "APPLY_STALE",
      retryable: false,
      safeMessage: safeMessageOf(error),
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

  // An unmapped store error at this boundary is a bug to surface, not swallow (errore rule 21).
  console.warn("store/adapters: unmapped store error folded to PERSISTENCE_FAILED:", error);
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: safeMessageOf(error),
    details: {},
  };
}

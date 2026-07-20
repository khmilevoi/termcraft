import type { DurabilityError } from "infrastructure/durability"
import type { Clock } from "infrastructure/clock"

import type { DataFormatTooNewError, NoMigrationPathError } from "./model/registry"
import type { MigrationBackupFailedError, MigrationIoError, MigrationStaleError } from "./model/backup-store"

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed
 * relative path. `store/types.ts` (T19) owns the shared alias; this local declaration
 * keeps the submodule self-contained until then.
 */
export type AbsPath = string

/** Lowercase-hex SHA-256, declared locally per this codebase's own convention (mirrors `store/trust`, `store/transaction`). */
export type Sha256Hex = string

// ---- registry (storage-identity §12) -------------------------------------------------

/**
 * The three durable-format counter field names storage-identity §12 fixes, one per
 * artifact family: `project.toml`/`workspace.local.toml` use `format_version`; JSONL uses
 * its typed header's `formatVersion`; every other JSON uses `schemaVersion`.
 */
export type FormatCounterField = "format_version" | "formatVersion" | "schemaVersion"

/**
 * One registered migration step for one durable-format `kind` (storage-identity §12).
 * `kind` names the artifact family (e.g. `"project.toml"`, `"chat-jsonl"`) — a plain
 * string rather than a fixed enum, since new kinds land in later phases without this
 * module needing to know their names in advance.
 */
export interface MigrationStep {
  readonly kind: string
  readonly fromVersion: number
  readonly toVersion: number
}

/**
 * The live migration registry (storage-identity §12): the real chain-lookup path a
 * future migration caller would use, plus the shared "too-new" format-counter gate.
 * `chain` is EMPTY in the shipped instance — see `model/registry.ts`'s header comment
 * for why that must stay true in this phase.
 */
export interface MigrationRegistry {
  readonly chain: readonly MigrationStep[]
  findSteps(input: { kind: string; fromVersion: number; toVersion: number }): NoMigrationPathError | readonly MigrationStep[]
  checkNotTooNew(input: { file: string; field: FormatCounterField; found: number; supported: number }): DataFormatTooNewError | null
}

// ---- backup store (storage-identity §12, turn-durability §11) ------------------------

/**
 * One file the caller wants included in a verified backup: its project-relative path,
 * exact bytes, and format tag (storage-identity §12's "source format" per copied file).
 *
 * JUDGMENT CALL (§11 step 3 gap, documented not silent): §11 says the copy happens
 * "through SafeProjectFs", but `SafeProjectFs`'s public surface (`store/safe-fs`) is
 * read-only — no write method exists to copy INTO. This module's contract is therefore
 * that the CALLER has already read `bytes` via `SafeProjectFs.readFile` (which already
 * enforces the §5.2 regular/single-link/non-reparse leaf rules on the source); this
 * module trusts that guarantee and never re-opens the live project tree itself.
 */
export interface BackupFileInput {
  readonly relPath: string
  readonly bytes: Uint8Array
  /** e.g. `"project.toml@1"`. */
  readonly sourceFormat: string
}

/** One `backup-manifest.json` file entry (turn-durability §11 step 4). */
export interface BackupManifestFileEntry {
  readonly relPath: string
  readonly byteLength: number
  readonly sha256: Sha256Hex
  readonly sourceFormat: string
  /** UTC RFC 3339. */
  readonly backupTime: string
}

/**
 * `backup-manifest.json`'s complete contract (turn-durability §11 step 4). It is itself
 * "other JSON" in storage-identity §12's format-counter taxonomy, so it carries its own
 * `schemaVersion` rather than reusing a TOML/JSONL field name.
 */
export interface BackupManifest {
  readonly schemaVersion: 1
  readonly canonicalProjectPath: string
  readonly projectId: string
  readonly termcraftVersion: string
  readonly files: readonly BackupManifestFileEntry[]
}

export interface CreateBackupInput {
  readonly projectId: string
  readonly migrationActionId: string
  readonly canonicalProjectPath: string
  readonly termcraftVersion: string
  readonly files: readonly BackupFileInput[]
}

/** The verified result of one completed backup (storage-identity §12 step 5). */
export interface VerifiedBackup {
  readonly backupDir: AbsPath
  readonly manifest: BackupManifest
  /** SHA-256 of the manifest's exact written bytes — the `VERIFIED` marker's payload and, downstream, `MigrationTransactionInput.backupManifestDigest`. */
  readonly manifestDigest: Sha256Hex
}

/**
 * The §12 verified-backup protocol under `{userStateRoot}/backups/{projectId}/{migrationActionId}/`,
 * outside every project's own `.termcraft/`.
 */
export interface BackupStore {
  createBackup(input: CreateBackupInput): Promise<MigrationBackupFailedError | VerifiedBackup>
}

/**
 * The impure boundary `BackupStore` needs, injected so tests drive a failing copy,
 * manifest write, or create-new collision against fakes. `nodeBackupStoreDeps` is the
 * production wiring over `infrastructure/durability`'s durable install plus plain
 * mkdir/read (see `model/backup-store.ts`'s header comment for why the reopen-and-verify
 * read stays a plain read rather than a second `SafeProjectFs` root).
 */
export interface BackupStoreDeps {
  readonly userStateRoot: AbsPath
  readonly clock: Clock
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => DurabilityError | undefined
  /** Recursive create-if-missing, for the `{userStateRoot}/backups/{projectId}` parent tree. */
  readonly ensureDir: (absDir: AbsPath) => MigrationIoError | undefined
  /** Non-recursive create-new; fails if anything already occupies the path (the `{migrationActionId}` directory itself). */
  readonly mkdirNew: (absDir: AbsPath) => MigrationIoError | undefined
  readonly readFile: (absPath: AbsPath) => Uint8Array | MigrationIoError
}

/** Any failure `store/migration` can return — a `_tag`-discriminated union for propagating callers. */
export type MigrationError = DataFormatTooNewError | NoMigrationPathError | MigrationBackupFailedError | MigrationIoError | MigrationStaleError

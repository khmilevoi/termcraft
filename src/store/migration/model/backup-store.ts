import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

import type { Clock } from "infrastructure/clock";
import { durableFileWrite } from "infrastructure/durability";
import { sha256Hex } from "store/jsonl";

import type {
  AbsPath,
  BackupManifest,
  BackupManifestFileEntry,
  BackupStore,
  BackupStoreDeps,
  CreateBackupInput,
} from "../types";

// `store/migration`'s backup store — the storage-identity §12 / turn-durability §11
// verified-backup protocol under `{userStateRoot}/backups/{projectId}/{migrationActionId}/`,
// OUTSIDE every project's own `.termcraft/`. Every durable file kind's first rewrite —
// whether triggered by a bulk migration or a lazy next-write codemod — must complete this
// protocol before the rewrite is even planned: copy every file → write the manifest →
// durably flush both → reopen every copy and verify its length/SHA-256 against BOTH the
// source bytes and the manifest entry → write the `VERIFIED` marker LAST, only once every
// prior check has succeeded.
//
// This module never touches the project's own files — it only reads the bytes the caller
// hands it and writes into the backup tree. "Insufficient space, permission errors, copy
// errors, flush errors, or hash mismatch abort migration with every project file
// unchanged" (§12) therefore holds by construction here, not by a guard this module has
// to remember to add. Likewise "being inside a Git repository never weakens or skips this
// protocol" (§12): nothing in this module ever inspects Git, so there is no branch that
// could skip a step for a Git-tracked project.
//
// JUDGMENT CALL (§11 step 3 gap, documented not silent — see `../types.ts`'s
// `BackupFileInput` doc comment): §11 says the copy happens "through SafeProjectFs", but
// `SafeProjectFs`'s public surface (`store/safe-fs`) exposes no write method. The CALLER
// is therefore the one that reads each source file with `SafeProjectFs.readFile` (which
// already enforces the §5.2 regular/single-link/non-reparse leaf rules) and hands this
// module the resulting bytes. The reopen-and-verify step below reads back the copies THIS
// module just wrote — bytes on disk this process alone controls, seconds earlier, not an
// externally-controlled input — so it reads with a plain injected `readFile` rather than a
// second managed root, keeping this task's boundary the two files it owns.

/** A raw filesystem operation this store performs directly (mkdir/read) failed. */
export class MigrationIoError extends errore.createTaggedError({
  name: "MigrationIoError",
  message: "migration backup $operation failed for $path",
}) {}

/** One `createBackup` call failed at a named step; every project file remains unchanged (see module header). */
export class MigrationBackupFailedError extends errore.createTaggedError({
  name: "MigrationBackupFailedError",
  message:
    "migration backup for project $projectId action $migrationActionId failed at step $step: $reason",
}) {}

/**
 * storage-identity §12 step 6 / turn-durability §11 step 6: a migration's source targets
 * drifted between the verified backup and the pre-intent re-check. The verified backup
 * itself is never discarded on this path — only the in-flight migration candidate is
 * (§11: "the verified backup may remain for diagnosis, but no source changes"). No
 * production caller exists yet (no shipped migration — `model/registry.ts`'s empty
 * chain); this error is exercised by the synthetic end-to-end test's
 * `MigrationTransaction` precondition in `backup-store.test.ts`.
 */
export class MigrationStaleError extends errore.createTaggedError({
  name: "MigrationStaleError",
  message: "migration_stale: $part drifted from the pre-backup snapshot",
}) {}

// ---- layout (turn-durability §11 step 3) -----------------------------------------------

export const BACKUPS_DIR_NAME = "backups";
export const BACKUP_MANIFEST_FILENAME = "backup-manifest.json";
export const BACKUP_VERIFIED_FILENAME = "VERIFIED";
/** `backup-manifest.json`/`VERIFIED`'s own `schemaVersion` (storage-identity §12's "other JSON" counter). */
export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;

export function backupsRootDir(userStateRoot: AbsPath): AbsPath {
  return path.join(userStateRoot, BACKUPS_DIR_NAME);
}
export function projectBackupsDir(userStateRoot: AbsPath, projectId: string): AbsPath {
  return path.join(backupsRootDir(userStateRoot), projectId);
}
export function backupActionDir(
  userStateRoot: AbsPath,
  projectId: string,
  migrationActionId: string,
): AbsPath {
  return path.join(projectBackupsDir(userStateRoot, projectId), migrationActionId);
}
export function backupManifestPath(
  userStateRoot: AbsPath,
  projectId: string,
  migrationActionId: string,
): AbsPath {
  return path.join(
    backupActionDir(userStateRoot, projectId, migrationActionId),
    BACKUP_MANIFEST_FILENAME,
  );
}
export function backupVerifiedMarkerPath(
  userStateRoot: AbsPath,
  projectId: string,
  migrationActionId: string,
): AbsPath {
  return path.join(
    backupActionDir(userStateRoot, projectId, migrationActionId),
    BACKUP_VERIFIED_FILENAME,
  );
}

// ---- production wiring -----------------------------------------------------------------

/** The real Node/Bun bindings: `infrastructure/durability`'s durable install plus plain mkdir/read. */
export function nodeBackupStoreDeps(userStateRoot: AbsPath, clock: Clock): BackupStoreDeps {
  return {
    userStateRoot,
    clock,
    durableWrite: durableFileWrite,
    ensureDir: (absDir) => {
      const made = errore.try({
        try: () => {
          fs.mkdirSync(absDir, { recursive: true });
          return undefined;
        },
        catch: (cause) => new MigrationIoError({ operation: "mkdir", path: absDir, cause }),
      });
      return made instanceof Error ? made : undefined;
    },
    mkdirNew: (absDir) => {
      // Non-recursive on purpose: `mkdirSync` without `recursive` fails with EEXIST when
      // anything already occupies the path, which is what makes the migrationActionId
      // directory create-new (turn-durability §11 step 3).
      const made = errore.try({
        try: () => {
          fs.mkdirSync(absDir);
          return undefined;
        },
        catch: (cause) => new MigrationIoError({ operation: "mkdir-new", path: absDir, cause }),
      });
      return made instanceof Error ? made : undefined;
    },
    readFile: (absPath) =>
      errore.try({
        try: () => new Uint8Array(fs.readFileSync(absPath)),
        catch: (cause) => new MigrationIoError({ operation: "read", path: absPath, cause }),
      }),
  };
}

// ---- the protocol -----------------------------------------------------------------------

function joinRelPath(dir: AbsPath, relPath: string): AbsPath {
  return path.join(dir, ...relPath.split("/"));
}

function failed(
  input: CreateBackupInput,
  step: string,
  reason: string,
  cause: unknown,
): MigrationBackupFailedError {
  return new MigrationBackupFailedError({
    projectId: input.projectId,
    migrationActionId: input.migrationActionId,
    step,
    reason,
    cause,
  });
}

/**
 * The §12 verified-backup protocol (storage-identity §12 steps 1-5; turn-durability §11
 * steps 3-4): create-new the action directory, copy every file, write the manifest,
 * reopen every copy and verify it against BOTH the source and the manifest, then write
 * `VERIFIED` last.
 */
export function createBackupStore(deps: BackupStoreDeps): BackupStore {
  return {
    async createBackup(input: CreateBackupInput) {
      const dir = backupActionDir(deps.userStateRoot, input.projectId, input.migrationActionId);

      const parentReady = deps.ensureDir(projectBackupsDir(deps.userStateRoot, input.projectId));
      if (parentReady instanceof Error)
        return failed(input, "ensure-parent", parentReady.message, parentReady);

      const created = deps.mkdirNew(dir);
      if (created instanceof Error) return failed(input, "create-new", created.message, created);

      const files: BackupManifestFileEntry[] = [];
      for (const file of input.files) {
        const destPath = joinRelPath(dir, file.relPath);
        const parent = path.dirname(destPath);
        if (parent !== dir) {
          const madeParent = deps.ensureDir(parent);
          if (madeParent instanceof Error)
            return failed(input, `copy:${file.relPath}`, madeParent.message, madeParent);
        }
        const written = deps.durableWrite(destPath, file.bytes);
        if (written instanceof Error)
          return failed(input, `copy:${file.relPath}`, written.message, written);

        files.push({
          relPath: file.relPath,
          byteLength: file.bytes.byteLength,
          sha256: sha256Hex(file.bytes),
          sourceFormat: file.sourceFormat,
          backupTime: deps.clock.now().toISOString(),
        });
      }

      const manifest: BackupManifest = {
        schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
        canonicalProjectPath: input.canonicalProjectPath,
        projectId: input.projectId,
        termcraftVersion: input.termcraftVersion,
        files,
      };
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      const wroteManifest = deps.durableWrite(
        backupManifestPath(deps.userStateRoot, input.projectId, input.migrationActionId),
        manifestBytes,
      );
      if (wroteManifest instanceof Error)
        return failed(input, "manifest", wroteManifest.message, wroteManifest);

      // Reopen every copy and verify length + SHA-256 against BOTH the source and the
      // manifest (storage-identity §12 step 4) — a deliberate second pass distinct from
      // `durableFileWrite`'s own internal reopen-verify, run only after every copy AND
      // the manifest are durable.
      for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index];
        const entry = files[index];
        // Unreachable: `files` is built by one pass over `input.files`, so the arrays are
        // index-aligned and equal-length. Fails CLOSED rather than `continue`-ing — silently
        // skipping a file's verification is the exact failure mode step 4 exists to prevent.
        if (file === undefined || entry === undefined) {
          return failed(
            input,
            `verify:index-${index}`,
            "the copy inventory is not aligned with the input file list",
            null,
          );
        }

        const destPath = joinRelPath(dir, file.relPath);
        const reopened = deps.readFile(destPath);
        if (reopened instanceof Error)
          return failed(input, `verify:${file.relPath}`, reopened.message, reopened);

        const sourceDigest = sha256Hex(file.bytes);
        const reopenedDigest = sha256Hex(reopened);
        if (reopened.byteLength !== file.bytes.byteLength || reopenedDigest !== sourceDigest) {
          return failed(
            input,
            `verify:${file.relPath}`,
            "the reopened copy does not match the source bytes",
            null,
          );
        }
        if (reopened.byteLength !== entry.byteLength || reopenedDigest !== entry.sha256) {
          return failed(
            input,
            `verify:${file.relPath}`,
            "the reopened copy does not match its manifest entry",
            null,
          );
        }
      }

      const manifestDigest = sha256Hex(manifestBytes);
      const verifiedBytes = new TextEncoder().encode(
        JSON.stringify({ schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION, manifestDigest }),
      );
      const wroteVerified = deps.durableWrite(
        backupVerifiedMarkerPath(deps.userStateRoot, input.projectId, input.migrationActionId),
        verifiedBytes,
      );
      if (wroteVerified instanceof Error)
        return failed(input, "verified-marker", wroteVerified.message, wroteVerified);

      return { backupDir: dir, manifest, manifestDigest };
    },
  };
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Clock } from "infrastructure/clock";
import { DurableWriteError } from "infrastructure/durability";
import { uuidv7 } from "infrastructure/uuid";
import { sha256Hex } from "store/jsonl";
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";
import {
  PROJECT_MANIFEST_FILENAME,
  decodeProjectManifest,
  encodeProjectManifest,
} from "store/toml";
import type { ProjectManifest } from "store/toml";
import {
  buildMigrationTransaction,
  createWriteMutex,
  nodeTransactionFsDeps,
} from "store/transaction";
import type { FileImage, TransactionOperation, TransactionWrapperDeps } from "store/transaction";

import type { BackupStoreDeps, CreateBackupInput } from "../types";
import {
  BACKUP_MANIFEST_FILENAME,
  MigrationBackupFailedError,
  MigrationIoError,
  MigrationStaleError,
  backupActionDir,
  backupManifestPath,
  backupVerifiedMarkerPath,
  createBackupStore,
  nodeBackupStoreDeps,
} from "./backup-store";

const TS = "2026-07-20T10:00:00Z";
const CLOCK: Clock = { now: () => new Date(TS) };
const USER_STATE_ROOT = "/state";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function baseInput(
  overrides: Partial<CreateBackupInput> & { readonly files: CreateBackupInput["files"] },
): CreateBackupInput {
  return {
    projectId: uuidv7(),
    migrationActionId: uuidv7(),
    canonicalProjectPath: "C:/work/demo/.termcraft",
    termcraftVersion: "0.0.0-test",
    ...overrides,
  };
}

// ==========================================================================================
// The verified-backup protocol against fakes: copy -> manifest -> reopen-and-verify -> VERIFIED
// ==========================================================================================

function makeFakeDeps(
  overrides: {
    failDurableWriteFor?: (absPath: string) => boolean;
    failMkdirNewFor?: (absDir: string) => boolean;
    corruptReadFor?: (absPath: string, original: Uint8Array) => Uint8Array;
  } = {},
): { deps: BackupStoreDeps; files: Map<string, Uint8Array>; writeLog: string[] } {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const writeLog: string[] = [];

  const deps: BackupStoreDeps = {
    userStateRoot: USER_STATE_ROOT,
    clock: CLOCK,
    ensureDir: (absDir) => {
      dirs.add(absDir);
      return undefined;
    },
    mkdirNew: (absDir) => {
      if (overrides.failMkdirNewFor?.(absDir) === true)
        return new MigrationIoError({
          operation: "mkdir-new",
          path: absDir,
          cause: new Error("simulated"),
        });
      if (dirs.has(absDir))
        return new MigrationIoError({
          operation: "mkdir-new",
          path: absDir,
          cause: new Error("EEXIST"),
        });
      dirs.add(absDir);
      return undefined;
    },
    durableWrite: (absPath, bytes) => {
      if (overrides.failDurableWriteFor?.(absPath) === true)
        return new DurableWriteError({ path: absPath, step: "write" });
      files.set(absPath, bytes);
      writeLog.push(absPath);
      return undefined;
    },
    readFile: (absPath) => {
      const original = files.get(absPath);
      if (original === undefined)
        return new MigrationIoError({
          operation: "read",
          path: absPath,
          cause: new Error("ENOENT"),
        });
      return overrides.corruptReadFor?.(absPath, original) ?? original;
    },
  };
  return { deps, files, writeLog };
}

describe("createBackupStore — the §12 verified-backup protocol", () => {
  test("copies every file, writes the manifest, verifies each copy, then writes VERIFIED last", async () => {
    const { deps, files, writeLog } = makeFakeDeps();
    const store = createBackupStore(deps);
    const bytesA = bytesOf("project.toml contents");
    const bytesB = bytesOf("workspace.local.toml contents");
    const input = baseInput({
      files: [
        { relPath: "project.toml", bytes: bytesA, sourceFormat: "project.toml@1" },
        { relPath: "workspace.local.toml", bytes: bytesB, sourceFormat: "workspace.local.toml@1" },
      ],
    });

    const result = await store.createBackup(input);
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(result.backupDir).toBe(
      backupActionDir(USER_STATE_ROOT, input.projectId, input.migrationActionId),
    );
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.canonicalProjectPath).toBe(input.canonicalProjectPath);
    expect(result.manifest.projectId).toBe(input.projectId);
    expect(result.manifest.termcraftVersion).toBe(input.termcraftVersion);
    expect(result.manifest.files).toEqual([
      {
        relPath: "project.toml",
        byteLength: bytesA.byteLength,
        sha256: sha256Hex(bytesA),
        sourceFormat: "project.toml@1",
        backupTime: new Date(TS).toISOString(),
      },
      {
        relPath: "workspace.local.toml",
        byteLength: bytesB.byteLength,
        sha256: sha256Hex(bytesB),
        sourceFormat: "workspace.local.toml@1",
        backupTime: new Date(TS).toISOString(),
      },
    ]);
    expect(result.manifestDigest).toBe(sha256Hex(bytesOf(JSON.stringify(result.manifest))));

    const manifestPath = backupManifestPath(
      USER_STATE_ROOT,
      input.projectId,
      input.migrationActionId,
    );
    const verifiedPath = backupVerifiedMarkerPath(
      USER_STATE_ROOT,
      input.projectId,
      input.migrationActionId,
    );
    expect(files.has(manifestPath)).toBe(true);
    expect(files.has(verifiedPath)).toBe(true);

    // VERIFIED is written strictly last, after every copy and the manifest.
    expect(writeLog[writeLog.length - 1]).toBe(verifiedPath);
    expect(writeLog.indexOf(manifestPath)).toBeGreaterThan(-1);
    expect(writeLog.indexOf(manifestPath)).toBeLessThan(writeLog.indexOf(verifiedPath));
    for (const file of input.files) {
      const destPath = path.join(result.backupDir, file.relPath);
      expect(writeLog.indexOf(destPath)).toBeLessThan(writeLog.indexOf(manifestPath));
    }
  });

  test("completes the same unconditional protocol whether or not the project is Git-tracked (storage-identity §12: Git presence never waives backup)", async () => {
    // This module never inspects Git at all — there is no branch that could skip a step for
    // a Git-tracked project, so the invariant holds structurally. This test documents that
    // by running the ordinary happy path and asserting the full protocol still completed.
    const { deps, files } = makeFakeDeps();
    const store = createBackupStore(deps);
    const input = baseInput({
      files: [{ relPath: "project.toml", bytes: bytesOf("v1"), sourceFormat: "project.toml@1" }],
    });

    const result = await store.createBackup(input);
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);
    expect(
      files.has(
        backupVerifiedMarkerPath(USER_STATE_ROOT, input.projectId, input.migrationActionId),
      ),
    ).toBe(true);
  });

  test("a create-new collision on the migrationActionId directory fails before any copy", async () => {
    const { deps } = makeFakeDeps();
    const store = createBackupStore(deps);
    const input = baseInput({
      files: [{ relPath: "project.toml", bytes: bytesOf("v1"), sourceFormat: "project.toml@1" }],
    });

    const first = await store.createBackup(input);
    if (first instanceof Error)
      throw new Error(`unexpected error on first backup: ${first.message}`);

    const second = await store.createBackup(input); // same migrationActionId reused deliberately
    expect(second).toBeInstanceOf(MigrationBackupFailedError);
    if (second instanceof MigrationBackupFailedError) expect(second.step).toBe("create-new");
  });

  test("a copy failure fails at the copy step and never writes the manifest or VERIFIED", async () => {
    const relPath = "project.toml";
    const { deps, files } = makeFakeDeps({
      failDurableWriteFor: (absPath) => absPath.endsWith(relPath),
    });
    const store = createBackupStore(deps);
    const input = baseInput({
      files: [{ relPath, bytes: bytesOf("v1"), sourceFormat: "project.toml@1" }],
    });

    const result = await store.createBackup(input);
    expect(result).toBeInstanceOf(MigrationBackupFailedError);
    if (result instanceof MigrationBackupFailedError) expect(result.step).toBe(`copy:${relPath}`);
    expect(
      files.has(backupManifestPath(USER_STATE_ROOT, input.projectId, input.migrationActionId)),
    ).toBe(false);
    expect(
      files.has(
        backupVerifiedMarkerPath(USER_STATE_ROOT, input.projectId, input.migrationActionId),
      ),
    ).toBe(false);
  });

  test("a manifest write failure never writes VERIFIED", async () => {
    const { deps, files } = makeFakeDeps({
      failDurableWriteFor: (absPath) => absPath.endsWith(BACKUP_MANIFEST_FILENAME),
    });
    const store = createBackupStore(deps);
    const input = baseInput({
      files: [{ relPath: "project.toml", bytes: bytesOf("v1"), sourceFormat: "project.toml@1" }],
    });

    const result = await store.createBackup(input);
    expect(result).toBeInstanceOf(MigrationBackupFailedError);
    if (result instanceof MigrationBackupFailedError) expect(result.step).toBe("manifest");
    expect(
      files.has(
        backupVerifiedMarkerPath(USER_STATE_ROOT, input.projectId, input.migrationActionId),
      ),
    ).toBe(false);
  });

  test("a reopened copy that disagrees with the source and the manifest fails verification and never writes VERIFIED", async () => {
    const relPath = "project.toml";
    const { deps, files } = makeFakeDeps({
      corruptReadFor: (absPath) =>
        absPath.endsWith(relPath) ? bytesOf("corrupted on disk") : bytesOf("unused"),
    });
    const store = createBackupStore(deps);
    const input = baseInput({
      files: [{ relPath, bytes: bytesOf("v1"), sourceFormat: "project.toml@1" }],
    });

    const result = await store.createBackup(input);
    expect(result).toBeInstanceOf(MigrationBackupFailedError);
    if (result instanceof MigrationBackupFailedError) expect(result.step).toBe(`verify:${relPath}`);
    expect(
      files.has(
        backupVerifiedMarkerPath(USER_STATE_ROOT, input.projectId, input.migrationActionId),
      ),
    ).toBe(false);
  });

  test("path helpers compose {userStateRoot}/backups/{projectId}/{migrationActionId}", () => {
    const projectId = uuidv7();
    const migrationActionId = uuidv7();
    expect(backupActionDir(USER_STATE_ROOT, projectId, migrationActionId)).toBe(
      path.join(USER_STATE_ROOT, "backups", projectId, migrationActionId),
    );
    expect(backupManifestPath(USER_STATE_ROOT, projectId, migrationActionId)).toBe(
      path.join(USER_STATE_ROOT, "backups", projectId, migrationActionId, "backup-manifest.json"),
    );
    expect(backupVerifiedMarkerPath(USER_STATE_ROOT, projectId, migrationActionId)).toBe(
      path.join(USER_STATE_ROOT, "backups", projectId, migrationActionId, "VERIFIED"),
    );
  });
});

// ==========================================================================================
// Synthetic end-to-end migration (turn-durability §14.8): backup -> verify -> transform ->
// MigrationTransaction, through the LIVE infra (real filesystem, real store/transaction,
// real store/safe-fs). No production migration exists (model/registry.ts's empty
// MIGRATION_CHAIN) — this is the test-only proof that the shared protocol works end to end.
// ==========================================================================================

describe("synthetic end-to-end migration", () => {
  const PROJECT_ID = uuidv7();

  let scratch = "";
  let termcraftDir = "";
  let userStateRoot = "";

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-migration-"));
    termcraftDir = path.join(scratch, ".termcraft");
    fs.mkdirSync(termcraftDir);
    userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-migration-state-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(userStateRoot, { recursive: true, force: true });
  });

  function openSafeFs(): SafeProjectFs {
    const deps = nodeSafeFsDeps();
    const root = openManagedRoot({ kind: "project", path: termcraftDir, deps });
    if (root instanceof Error) throw new Error(`openManagedRoot failed: ${root.message}`);
    return createSafeProjectFs(root, deps);
  }

  function wrapperDeps(): TransactionWrapperDeps {
    return { fs: nodeTransactionFsDeps(openSafeFs()), append: { newPayloadId: uuidv7 } };
  }

  function seedOldManifest(): Uint8Array {
    const manifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "old-name",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const bytes = bytesOf(encodeProjectManifest(manifest));
    fs.writeFileSync(path.join(termcraftDir, PROJECT_MANIFEST_FILENAME), bytes);
    return bytes;
  }

  function currentManifestBytes(): Uint8Array {
    return new Uint8Array(fs.readFileSync(path.join(termcraftDir, PROJECT_MANIFEST_FILENAME)));
  }

  /** The migration's pre-intent re-CAS (storage-identity §12 step 6 / turn-durability §11 step 6). */
  function stalePrecondition(expected: Uint8Array) {
    return (): MigrationStaleError | null => {
      if (sha256Hex(currentManifestBytes()) !== sha256Hex(expected))
        return new MigrationStaleError({ part: PROJECT_MANIFEST_FILENAME });
      return null;
    };
  }

  test("happy path: verified backup, transform, then MigrationTransaction commits the new file", async () => {
    const sourceBytes = seedOldManifest();
    const migrationActionId = uuidv7();

    const backup = await createBackupStore(nodeBackupStoreDeps(userStateRoot, CLOCK)).createBackup({
      projectId: PROJECT_ID,
      migrationActionId,
      canonicalProjectPath: termcraftDir,
      termcraftVersion: "0.0.0-test",
      files: [
        { relPath: PROJECT_MANIFEST_FILENAME, bytes: sourceBytes, sourceFormat: "project.toml@1" },
      ],
    });
    if (backup instanceof Error) throw new Error(`unexpected backup error: ${backup.message}`);
    expect(
      fs.existsSync(backupVerifiedMarkerPath(userStateRoot, PROJECT_ID, migrationActionId)),
    ).toBe(true);
    expect(fs.existsSync(backupManifestPath(userStateRoot, PROJECT_ID, migrationActionId))).toBe(
      true,
    );

    // Synthetic "transform": a real migration would decode format N and re-encode format
    // N+1; here it is simply a re-encoded manifest with a different name.
    const newManifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "migrated-name",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const newBytes = bytesOf(encodeProjectManifest(newManifest));
    const payloadId = uuidv7();
    const oldImage: FileImage = {
      state: "file",
      sha256: sha256Hex(sourceBytes),
      size: sourceBytes.byteLength,
    };
    const operation: TransactionOperation = {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
      payloadId,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const result = await buildMigrationTransaction(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      migrationPlanId: uuidv7(),
      migrationActionId,
      backupManifestDigest: backup.manifestDigest,
      operations: [operation],
      payloads: new Map([[payloadId, newBytes]]),
      createdAt: TS,
      precondition: stalePrecondition(sourceBytes),
    });
    if (result instanceof Error) throw new Error(`unexpected migration error: ${result.message}`);

    const onDisk = decodeProjectManifest(new TextDecoder().decode(currentManifestBytes()));
    if (onDisk instanceof Error) throw new Error(`fixture bug: ${onDisk.message}`);
    expect(onDisk.name).toBe("migrated-name");
  });

  test("source drift during backup yields migration_stale and leaves the source untouched", async () => {
    const sourceBytes = seedOldManifest();
    const migrationActionId = uuidv7();

    const backup = await createBackupStore(nodeBackupStoreDeps(userStateRoot, CLOCK)).createBackup({
      projectId: PROJECT_ID,
      migrationActionId,
      canonicalProjectPath: termcraftDir,
      termcraftVersion: "0.0.0-test",
      files: [
        { relPath: PROJECT_MANIFEST_FILENAME, bytes: sourceBytes, sourceFormat: "project.toml@1" },
      ],
    });
    if (backup instanceof Error) throw new Error(`unexpected backup error: ${backup.message}`);

    // A concurrent external edit lands AFTER the verified backup but BEFORE the migration's
    // pre-intent re-check.
    const driftedManifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "drifted-by-someone-else",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const driftedBytes = bytesOf(encodeProjectManifest(driftedManifest));
    fs.writeFileSync(path.join(termcraftDir, PROJECT_MANIFEST_FILENAME), driftedBytes);

    const newManifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "migrated-name",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const newBytes = bytesOf(encodeProjectManifest(newManifest));
    const payloadId = uuidv7();
    // The plan was built against the PRE-drift image — exactly what makes the re-check catch it.
    const oldImage: FileImage = {
      state: "file",
      sha256: sha256Hex(sourceBytes),
      size: sourceBytes.byteLength,
    };
    const operation: TransactionOperation = {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
      payloadId,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const result = await buildMigrationTransaction(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      migrationPlanId: uuidv7(),
      migrationActionId,
      backupManifestDigest: backup.manifestDigest,
      operations: [operation],
      payloads: new Map([[payloadId, newBytes]]),
      createdAt: TS,
      precondition: stalePrecondition(sourceBytes),
    });

    expect(result).toBeInstanceOf(MigrationStaleError);

    // The verified backup is retained for diagnosis; the source is exactly as the
    // concurrent drift left it — never overwritten by the abandoned migration candidate.
    expect(
      fs.existsSync(backupVerifiedMarkerPath(userStateRoot, PROJECT_ID, migrationActionId)),
    ).toBe(true);
    const onDisk = decodeProjectManifest(new TextDecoder().decode(currentManifestBytes()));
    if (onDisk instanceof Error) throw new Error(`fixture bug: ${onDisk.message}`);
    expect(onDisk.name).toBe("drifted-by-someone-else");
  });
});

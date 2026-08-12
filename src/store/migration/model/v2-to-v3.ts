import { sha256Hex } from "store/jsonl";
import { createDesignSystemSeedFiles } from "store/model/design-system-seed";
import type { SafeFsError } from "store/safe-fs";
import {
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  encodeProjectManifest,
} from "store/toml";
import { designFilePath, observeFileImage } from "store/transaction";
import type { TransactionOperation, TransactionWrapperDeps } from "store/transaction";

import type { AbsPath, BackupFileInput, FormatTwoProjectV1, MigrationPlanV1 } from "../types";
import { projectBackupsDir } from "./backup-store";

/**
 * The immutable v2 -> v3 plan (design-systems §9). PURE, exactly like `planV1ToV2`: it computes
 * from an already-completed scan and touches no disk, so the dialog draws from it and confirm-time
 * re-derivation from a fresh scan produces an equal value.
 *
 * `moves` is EMPTY and `pinLogCount` is 0 — the 2 -> 3 step relocates nothing. That is not a
 * placeholder: §9 says "no page source byte is ever edited programmatically", and an empty move
 * list is the honest statement of it. `seedsDesignSystem` is what the dialog draws instead.
 */
export function planV2ToV3(input: {
  readonly scan: FormatTwoProjectV1;
  readonly userStateRoot: AbsPath;
  readonly migrationPlanId: string;
}): MigrationPlanV1 {
  return {
    migrationPlanId: input.migrationPlanId,
    fromVersion: 2,
    toVersion: 3,
    projectId: input.scan.projectId,
    moves: [],
    pageCount: input.scan.pageCount,
    pinLogCount: 0,
    seedsDesignSystem: !input.scan.hasDesignSystem,
    backupsDir: projectBackupsDir(input.userStateRoot, input.scan.projectId),
  };
}

/**
 * The complete v2 -> v3 change, ready to run: the operations, their payloads, and the exact byte
 * set the verified backup must hold first.
 */
export interface V2ToV3OperationsV1 {
  readonly operations: readonly TransactionOperation[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  /** Every file the transaction overwrites — `project.toml` alone, since the seed files are new. */
  readonly backupFiles: readonly BackupFileInput[];
}

/**
 * Build the ONE transaction that seeds a format-2 project's design system (design-systems §9).
 *
 * AT MOST THREE WRITES, NO DELETES, AND `project.toml` IS LAST. That ordering is load-bearing for
 * the same reason `v1-to-v2.ts`'s writes-before-deletes ordering is: the engine applies operations
 * in index order and CAN crash mid-roll-forward, e.g. between the two seed writes, leaving a
 * `transactions.local/` directory that is `applied` but not yet `committed`.
 *
 * THE REAL SAFEGUARD IS NOT "the next open re-offers the migration and writes the same bytes" —
 * a naive re-offer, if one ever read `format_version` first, could see `design-system.json`
 * present without `tokens.ts` and, via `scanFormatTwoProject`'s `hasDesignSystem` check, skip the
 * seed entirely, permanently stranding the tree half-seeded. What actually rules this out is
 * ORDERING AT THE READ SITE, not disk-level idempotence: `recoverTransactions` runs BEFORE
 * anything reads `format_version` on every path that can observe this project again —
 * `openProject`'s step 4 (recover) precedes step 6 (schemas, which reads the manifest) in
 * `factory.ts`, and `migrateProject`'s own `openMigrationContext` runs recovery before
 * `migrateProject` ever calls `scanFormatTwoProject`. So any reader that reaches `format_version`
 * has ALREADY rolled an interrupted transaction forward to its full committed state (both seed
 * files and the rewritten `project.toml`) — it is never handed a half-seeded tree to misread.
 *
 * `project.toml` still goes LAST for its own, independent reason: a manifest written FIRST would
 * open a window — observable only by something that skips recovery, which nothing in this codebase
 * does, but the invariant should hold on its own terms — in which the manifest claims a design
 * system the tree does not yet have.
 *
 * AN EXISTING DESIGN SYSTEM IS PRESERVED. A project that installed one before its `format_version`
 * moved must not have it silently replaced by the seed; the version bump is then the whole change.
 *
 * NO PAGE SOURCE BYTE IS EDITED (§9). The code migration is a seeded agent turn, not a codemod.
 *
 * `deps.fs.safeFs` MUST be opened on the `project-migration` root kind, exactly as
 * `buildV1ToV2Operations` requires.
 */
export function buildV2ToV3Operations(
  deps: TransactionWrapperDeps,
  input: {
    readonly scan: FormatTwoProjectV1;
    readonly kitApiVersion: number;
    readonly newPayloadId: () => string;
  },
): SafeFsError | V2ToV3OperationsV1 {
  const writes: TransactionOperation[] = [];
  const payloads = new Map<string, Uint8Array>();
  const backupFiles: BackupFileInput[] = [];

  /** One `replace` whose payload is `bytes`, CASed against whatever is at `target` today. */
  const write = (target: string, bytes: Uint8Array): SafeFsError | undefined => {
    const oldImage = observeFileImage(deps.fs, target);
    if (oldImage instanceof Error) return oldImage;
    const payloadId = input.newPayloadId();
    payloads.set(payloadId, bytes);
    writes.push({
      index: 0, // renumbered densely below
      target,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    });
    return undefined;
  };

  // --- 1: the seeded design system, unless the project already has one -----------------------
  if (!input.scan.hasDesignSystem) {
    for (const file of createDesignSystemSeedFiles({ kitApiVersion: input.kitApiVersion })) {
      const wrote = write(designFilePath(file.relPath), file.bytes);
      if (wrote instanceof Error) return wrote;
    }
  }

  // --- 2: project.toml at the new format version, every other field verbatim -----------------
  const oldManifestBytes = deps.fs.safeFs.readFile(PROJECT_MANIFEST_FILENAME);
  if (oldManifestBytes instanceof Error) return oldManifestBytes;
  backupFiles.push({
    relPath: PROJECT_MANIFEST_FILENAME,
    bytes: oldManifestBytes,
    sourceFormat: `${PROJECT_MANIFEST_FILENAME}@${input.scan.formatVersion}`,
  });
  const newManifestBytes = new TextEncoder().encode(
    // Identity, name, creation time and target stack carried forward VERBATIM — a migration that
    // restamped `created_at` or re-minted `project_id` would break the trust ledger's own subject
    // and orphan every existing grant. The identical rule `buildV1ToV2Operations` states.
    encodeProjectManifest({
      formatVersion: PROJECT_MANIFEST_FORMAT_VERSION,
      projectId: input.scan.projectId,
      name: input.scan.name,
      createdAt: input.scan.createdAt,
      targetStack: input.scan.targetStack,
    }),
  );
  const wroteProjectToml = write(PROJECT_MANIFEST_FILENAME, newManifestBytes);
  if (wroteProjectToml instanceof Error) return wroteProjectToml;

  const ordered = writes.map((operation, index) => ({ ...operation, index }));
  return { operations: ordered, payloads, backupFiles };
}

import {
  DESIGN_DIRNAME,
  PAGES_MANIFEST_RELPATH,
  PAGES_MANIFEST_SCHEMA_VERSION,
  encodePagesManifest,
} from "entities/design-tree";
import type { PageSlug } from "entities/page";
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

import type {
  AbsPath,
  BackupFileInput,
  LegacyProjectV1,
  MigrationMoveV1,
  MigrationPlanV1,
} from "../types";
import { projectBackupsDir } from "./backup-store";

/** `design/pages/<slug>.tsx` — where a migrated version-1 page lands (design §12.2). */
export function migratedSourcePath(slug: PageSlug): string {
  return `${DESIGN_DIRNAME}/pages/${slug}.tsx`;
}

/** `pins/<slug>.jsonl` — where a migrated version-1 pin log lands (design §3, §12.2). */
export function migratedPinsPath(slug: PageSlug): string {
  return `pins/${slug}.jsonl`;
}

/**
 * The immutable v1 -> v3 plan (design-tree §12.2 track 1; design-systems §9 ruling 1). PURE: it
 * computes paths and counts from an already-completed scan and touches no disk, so the dialog can
 * be drawn from it and the same shape can be re-derived from a fresh scan at confirm time without
 * a second I/O pass.
 *
 * `toVersion` is 3, not 2: a version-1 project migrates STRAIGHT to the current format in one
 * transaction (ruling 1 — `project.toml` is written exactly once), so the plan the dialog draws
 * from never claims an intermediate format 2 the tree does not actually pass through as a
 * separate write. The move set is exactly §12.2's four bullets, in this order:
 *   1. every `pages/<slug>/page.tsx` -> `design/pages/<slug>.tsx`
 *   2. every `pages/<slug>/comments.jsonl` that exists -> `pins/<slug>.jsonl`
 *   3. `design/pages.json` synthesized from `project.toml`'s ordered `pages` array (not a move —
 *      built by `buildV1ToV2Operations`, which is why it is not listed here)
 *   4. `project.toml` rewritten without `pages`, at `format_version = 3` (likewise)
 *   5. `design/system/` seeded, unless the scan already found one (not a move — built by
 *      `buildV1ToV2Operations`, which is why it is not listed here either). A version-1 layout has
 *      no `design/` tree by construction, so `seedsDesignSystem` is usually `true`, but ruling 4
 *      applies here exactly as it does on the version-2 origin: nothing stops a hand-edit, a
 *      third-party tool, or an abandoned earlier attempt from having created one already, and the
 *      seed must not silently replace it.
 *
 * NO PAGE SOURCE BYTE IS EDITED. §12.2: every page stays a self-contained single file importing
 * only `@termcraft/runtime`, which is still valid under §5/§6 — the new format PERMITS shared
 * modules, it does not require them. That is what makes track 1 sufficient on its own.
 */
export function planV1ToV2(input: {
  readonly scan: LegacyProjectV1;
  readonly userStateRoot: AbsPath;
  readonly migrationPlanId: string;
}): MigrationPlanV1 {
  const sources: MigrationMoveV1[] = input.scan.pages.map((page) => ({
    from: page.legacySourcePath,
    to: migratedSourcePath(page.slug),
    what: "page-source",
  }));
  const pinLogs: MigrationMoveV1[] = input.scan.pages
    .filter((page) => page.legacyPinsPath !== null)
    .map((page) => ({
      // `page.legacyPinsPath` is non-null inside this filter; the fallback exists only because
      // TypeScript cannot narrow through `.filter`, and it is unreachable.
      from: page.legacyPinsPath ?? "",
      to: migratedPinsPath(page.slug),
      what: "pin-log",
    }));

  return {
    migrationPlanId: input.migrationPlanId,
    fromVersion: 1,
    toVersion: 3,
    projectId: input.scan.projectId,
    moves: [...sources, ...pinLogs],
    pageCount: sources.length,
    pinLogCount: pinLogs.length,
    seedsDesignSystem: !input.scan.hasDesignSystem,
    // The REAL backup location (`{userStateRoot}/backups/<projectId>/`), outside `.termcraft` so a
    // Git operation cannot clobber it — `docs/architecture/storage.md` item 17. §12.3 records this
    // as a deliberate divergence from the dialog mockup, which draws
    // `.termcraft/backup-2026-07-13/`: the storage design wins and the dialog shows the real path.
    // The per-action subdirectory is NOT included: `migrationActionId` is minted at confirm time,
    // so naming it here would be a path that does not exist yet.
    backupsDir: projectBackupsDir(input.userStateRoot, input.scan.projectId),
  };
}

/**
 * The complete v1 -> v2 change, ready to run: the operations, their payloads, and the exact byte
 * set the verified backup must hold first.
 */
export interface V1ToV2OperationsV1 {
  readonly operations: readonly TransactionOperation[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
  /** Every file the transaction overwrites or deletes — never a superset, never a subset. */
  readonly backupFiles: readonly BackupFileInput[];
}

/**
 * Build the ONE transaction that performs the mechanical migration (design-tree §12.2 track 1;
 * design-systems §9 ruling 1: a format-1 project migrates STRAIGHT to format 3).
 *
 * ORDER IS LOAD-BEARING: every `replace` precedes every `delete`. The engine applies operations in
 * index order and rolls forward idempotently after a crash, so a roll-forward that stops midway
 * has, at every point, either the old file or the new one — never neither. Deleting first would
 * open a window in which a page exists nowhere.
 *
 * `oldImage` is observed for every target, so the engine's own CAS refuses the transaction if any
 * source byte drifted between the scan/backup and the commit intent (turn-durability §11 step 6).
 * That is why this function reads through `deps.fs.safeFs` rather than trusting the scan's paths:
 * the bytes it hands the backup and the images it CASes on are read in the same pass.
 *
 * FIVE THINGS, not four: relocate every page source and pin log (1, 2), synthesize
 * `design/pages.json` (3), seed `design/system/` (4, new — guarded by the SAME "only if absent"
 * rule `buildV2ToV3Operations` applies: a version-1 layout has no `design/` tree by construction,
 * so this is normally unconditional in practice, but `input.scan.hasDesignSystem` is checked
 * here too, so a hand-edit or an abandoned earlier attempt is never silently overwritten — see
 * `LegacyProjectV1.hasDesignSystem`'s own doc comment), then rewrite `project.toml` at the
 * current format version LAST (5) — `PROJECT_MANIFEST_FORMAT_VERSION` is now 3, so this step
 * alone, with no other manifest-logic edit, is what turns "1 -> 2" into "1 -> 3 in one
 * transaction" (ruling 1). Keeping the seed write before the manifest rewrite matters for the
 * identical reason `v2-to-v3.ts`'s own ordering comment gives: a `project.toml` written before the
 * tree actually holds `design/system/` would open a window where the manifest lies about it.
 *
 * `deps.fs.safeFs` MUST be opened on the `project-migration` root kind — every `pages/**` target
 * below is refused by the ordinary project grammar.
 */
export function buildV1ToV2Operations(
  deps: TransactionWrapperDeps,
  input: {
    readonly scan: LegacyProjectV1;
    readonly kitApiVersion: number;
    readonly newPayloadId: () => string;
  },
): SafeFsError | V1ToV2OperationsV1 {
  const writes: TransactionOperation[] = [];
  const deletes: TransactionOperation[] = [];
  const payloads = new Map<string, Uint8Array>();
  const backupFiles: BackupFileInput[] = [];

  /** One `replace` whose payload is `bytes`, CASed against whatever is at `target` today. */
  const write = (target: string, bytes: Uint8Array): SafeFsError | undefined => {
    const oldImage = observeFileImage(deps.fs, target);
    if (oldImage instanceof Error) return oldImage;
    const payloadId = input.newPayloadId();
    payloads.set(payloadId, bytes);
    writes.push({
      index: 0, // renumbered densely below, once both halves are known
      target,
      mode: "replace",
      oldImage,
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    });
    return undefined;
  };

  /** One `delete`, CASed against the bytes the backup just took. */
  const remove = (target: string): SafeFsError | undefined => {
    const oldImage = observeFileImage(deps.fs, target);
    if (oldImage instanceof Error) return oldImage;
    deletes.push({ index: 0, target, mode: "delete", oldImage, newImage: { state: "absent" } });
    return undefined;
  };

  // --- 1 + 2: relocate every page source and every pin log, bytes untouched ----------------
  for (const page of input.scan.pages) {
    const sourceBytes = deps.fs.safeFs.readFile(page.legacySourcePath);
    if (sourceBytes instanceof Error) return sourceBytes;
    backupFiles.push({
      relPath: page.legacySourcePath,
      bytes: sourceBytes,
      sourceFormat: "page.tsx@1",
    });
    const wroteSource = write(migratedSourcePath(page.slug), sourceBytes);
    if (wroteSource instanceof Error) return wroteSource;
    const removedSource = remove(page.legacySourcePath);
    if (removedSource instanceof Error) return removedSource;

    if (page.legacyPinsPath === null) continue;
    const pinBytes = deps.fs.safeFs.readFile(page.legacyPinsPath);
    if (pinBytes instanceof Error) return pinBytes;
    backupFiles.push({
      relPath: page.legacyPinsPath,
      bytes: pinBytes,
      sourceFormat: "comments.jsonl@1",
    });
    // The pin RECORDS are unchanged: `entities/pin`'s schema keys a pin by `pageSlug`, which the
    // migration preserves, so only the file's location moves.
    const wrotePins = write(migratedPinsPath(page.slug), pinBytes);
    if (wrotePins instanceof Error) return wrotePins;
    const removedPins = remove(page.legacyPinsPath);
    if (removedPins instanceof Error) return removedPins;
  }

  // --- 3: synthesize design/pages.json from project.toml's existing order -------------------
  const pagesManifestBytes = new TextEncoder().encode(
    encodePagesManifest({
      schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
      pages: input.scan.pages.map((page) => ({
        slug: page.slug,
        // Tree-RELATIVE, i.e. without the `design/` prefix — `PagesManifestV1.entry` is resolved
        // against the tree root (design §4), and `designFilePath` adds the prefix for the target.
        entry: `pages/${page.slug}.tsx`,
      })),
      // Format 1 had no "requested active page" concept — `workspace.local.toml`'s own
      // `activePageSlug` already carries the user's last active page and survives untouched, so
      // there is nothing to request here. `null` is the honest empty, not a placeholder.
      requestedActivePage: null,
    }),
  );
  const wroteManifest = write(designFilePath(PAGES_MANIFEST_RELPATH), pagesManifestBytes);
  if (wroteManifest instanceof Error) return wroteManifest;

  // --- 4: seed the project's design system, unless the scan already found one ---------------
  // (design-systems §9, ruling 1 + ruling 4). A format-1 layout has no `design/` tree by
  // construction, so `input.scan.hasDesignSystem` is normally `false` here — but this guard is
  // NOT a formality: skipping it would let a hand-edit, a third-party tool, or an abandoned
  // earlier attempt's `design/system/design-system.json` be silently overwritten by a `write()`
  // that observes it as `oldImage: { state: "file", … }` and never backs it up (`backupFiles`
  // must stay "never a superset, never a subset" — this interface's own doc comment above).
  if (!input.scan.hasDesignSystem) {
    for (const file of createDesignSystemSeedFiles({ kitApiVersion: input.kitApiVersion })) {
      const wroteSeed = write(designFilePath(file.relPath), file.bytes);
      if (wroteSeed instanceof Error) return wroteSeed;
    }
  }

  // --- 5: rewrite project.toml — drop `pages`, set the current format_version ---------------
  const oldManifestBytes = deps.fs.safeFs.readFile(PROJECT_MANIFEST_FILENAME);
  if (oldManifestBytes instanceof Error) return oldManifestBytes;
  backupFiles.push({
    relPath: PROJECT_MANIFEST_FILENAME,
    bytes: oldManifestBytes,
    sourceFormat: `${PROJECT_MANIFEST_FILENAME}@${input.scan.formatVersion}`,
  });
  const newManifestBytes = new TextEncoder().encode(
    // Identity, name, creation time and target stack are carried forward VERBATIM. A migration
    // that restamped `created_at` or re-minted `project_id` would break the trust ledger's own
    // subject (`store/trust`) and orphan every existing grant.
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

  const ordered = [...writes, ...deletes].map((operation, index) => ({ ...operation, index }));
  return { operations: ordered, payloads, backupFiles };
}

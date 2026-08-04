import { DESIGN_DIRNAME } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { AbsPath, LegacyProjectV1, MigrationMoveV1, MigrationPlanV1 } from "../types";
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
 * The immutable v1 -> v2 plan (design-tree §12.2 track 1). PURE: it computes paths and counts from
 * an already-completed scan and touches no disk, so the dialog can be drawn from it and the same
 * shape can be re-derived from a fresh scan at confirm time without a second I/O pass.
 *
 * The move set is exactly §12.2's four bullets, in this order:
 *   1. every `pages/<slug>/page.tsx` -> `design/pages/<slug>.tsx`
 *   2. every `pages/<slug>/comments.jsonl` that exists -> `pins/<slug>.jsonl`
 *   3. `design/pages.json` synthesized from `project.toml`'s ordered `pages` array (not a move —
 *      built by `buildV1ToV2Operations`, which is why it is not listed here)
 *   4. `project.toml` rewritten without `pages`, at `format_version = 2` (likewise)
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
    toVersion: 2,
    projectId: input.scan.projectId,
    moves: [...sources, ...pinLogs],
    pageCount: sources.length,
    pinLogCount: pinLogs.length,
    // The REAL backup location (`{userStateRoot}/backups/<projectId>/`), outside `.termcraft` so a
    // Git operation cannot clobber it — `docs/architecture/storage.md` item 17. §12.3 records this
    // as a deliberate divergence from the dialog mockup, which draws
    // `.termcraft/backup-2026-07-13/`: the storage design wins and the dialog shows the real path.
    // The per-action subdirectory is NOT included: `migrationActionId` is minted at confirm time,
    // so naming it here would be a path that does not exist yet.
    backupsDir: projectBackupsDir(input.userStateRoot, input.scan.projectId),
  };
}

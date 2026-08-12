import * as errore from "errore";
import { z } from "zod";

import { DESIGN_SYSTEM_MANIFEST_RELPATH } from "entities/design-system";
import { PAGES_MANIFEST_RELPATH, decodePagesManifest } from "entities/design-tree";
import { rfc3339UtcSchema } from "infrastructure/clock";
import { canonicalUuidv7Schema } from "infrastructure/uuid";
import type { SafeProjectFs } from "store/safe-fs";
import { PROJECT_MANIFEST_FILENAME, TARGET_STACKS, parseToml, readFormatVersion } from "store/toml";
import type { TargetStack } from "store/toml";
import { designFilePath } from "store/transaction";

import type { FormatTwoProjectV1 } from "../types";
import { probeLeaf } from "./legacy-scan";

/** The format-2 layout's own version number. Named, not inlined: every check below is about THIS. */
export const FORMAT_TWO_PROJECT_VERSION = 2;

/** What went wrong reading a version-2 project. `code` is the branch, not a message fragment. */
export type FormatTwoScanCodeV1 =
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_SHAPE"
  | "NOT_VERSION_2"
  | "PAGES_MANIFEST_UNREADABLE"
  /** A stat on `design/system/design-system.json` failed for a reason OTHER than "absent"
   *  (`probeLeaf`'s three-way result) — not in the brief's own code sketch, added because
   *  `FormatTwoScanError` needs a code to report it under rather than silently reusing a
   *  page-source-shaped one from `legacy-scan.ts`'s `probeLeaf`. */
  | "DESIGN_SYSTEM_PROBE_UNREADABLE";

/**
 * A version-2 project could not be read well enough to migrate it. Every branch names the
 * artifact it failed on, mirroring `LegacyScanError`'s own shape.
 */
export class FormatTwoScanError extends errore.createTaggedError({
  name: "FormatTwoScanError",
  message: "cannot read the version-2 project at $artifact [$code]: $reason",
}) {}

/**
 * The RETIRED format-2 `project.toml` schema. It lives here rather than in `store/toml` for
 * exactly `legacy-scan.ts`'s reason: shipping a version-2 decoder beside the version-3 one would
 * put a compatibility reader back into the live open path. Its ONLY caller is
 * `scanFormatTwoProject`.
 *
 * WHY `decodeProjectManifest` CANNOT SERVE THIS: its `format_version` is
 * `z.literal(PROJECT_MANIFEST_FORMAT_VERSION)` — now 3 — so it can only ever read a format-3
 * file, and it answers a format-2 one with `ManifestMigrationRequiredError`, which is precisely
 * the signal that brought us here.
 *
 * The field set is IDENTICAL to format 3's. The version moves because the project's TREE gained
 * a required folder, not because `project.toml` changed shape.
 */
const formatTwoProjectManifestSchema = z.strictObject({
  format_version: z.literal(FORMAT_TWO_PROJECT_VERSION),
  project_id: canonicalUuidv7Schema,
  name: z.string(),
  created_at: rfc3339UtcSchema,
  target_stack: z.enum(TARGET_STACKS),
});

/**
 * `design/pages.json`'s entry count, or the honest zero `readPageOrder`'s own allowance
 * describes: "a project has no manifest until its first turn writes one". UNLIKE the
 * design-SYSTEM manifest (plan P4 decision D7), an undecodable `pages.json` REFUSES rather than
 * falling back — it is the page-ORDER authority and the migration quotes its count in a
 * confirmation dialog, and a wrong count there is worse than a refusal the user can act on.
 */
function readPageCount(safeFs: SafeProjectFs): FormatTwoScanError | number {
  const pagesRelPath = designFilePath(PAGES_MANIFEST_RELPATH);
  const present = probeLeaf(safeFs, pagesRelPath);
  if (present instanceof Error)
    return new FormatTwoScanError({
      artifact: pagesRelPath,
      code: "PAGES_MANIFEST_UNREADABLE",
      reason: present.message,
      cause: present,
    });
  if (!present) return 0;

  const bytes = safeFs.readFile(pagesRelPath);
  if (bytes instanceof Error)
    return new FormatTwoScanError({
      artifact: pagesRelPath,
      code: "PAGES_MANIFEST_UNREADABLE",
      reason: bytes.message,
      cause: bytes,
    });

  const decoded = decodePagesManifest(new TextDecoder().decode(bytes));
  if (decoded instanceof Error)
    return new FormatTwoScanError({
      artifact: pagesRelPath,
      code: "PAGES_MANIFEST_UNREADABLE",
      reason: decoded.message,
      cause: decoded,
    });

  return decoded.pages.length;
}

/**
 * Read a version-2 project's portable facts (design-systems §9). This is the ONLY function in
 * the system that decodes the retired format-2 manifest schema; everything downstream (the
 * 2 -> 3 planner and operations builder) consumes its result.
 *
 * `safeFs` MUST be opened on the `project-migration` root kind — the same requirement
 * `scanLegacyProject` carries, so this scan and its write-path sibling always agree on which
 * paths are reachable.
 */
export function scanFormatTwoProject(
  safeFs: SafeProjectFs,
): FormatTwoScanError | FormatTwoProjectV1 {
  const bytes = safeFs.readFile(PROJECT_MANIFEST_FILENAME);
  if (bytes instanceof Error)
    return new FormatTwoScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_UNREADABLE",
      reason: bytes.message,
      cause: bytes,
    });

  const parsed = parseToml(new TextDecoder().decode(bytes));
  if (parsed instanceof Error)
    return new FormatTwoScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_UNREADABLE",
      reason: "file is not valid TOML",
      cause: parsed,
    });

  // The version gate runs BEFORE the field schema, exactly as `decodeProjectManifest` and
  // `scanLegacyProject` order their own: a format-1 or format-3 file handed to this scanner must
  // be reported as "not version 2", never as a pile of shape complaints.
  const version = readFormatVersion(parsed.value);
  if (version !== FORMAT_TWO_PROJECT_VERSION)
    return new FormatTwoScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "NOT_VERSION_2",
      reason: `format_version is ${version ?? "missing or non-integer"}, not 2`,
    });

  const decoded = formatTwoProjectManifestSchema.safeParse(parsed.value);
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    return new FormatTwoScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_SHAPE",
      reason: `${issue?.path.join(".") ?? "SHAPE"}: ${issue?.message ?? "invalid input"}`,
      cause: decoded.error,
    });
  }

  const pageCount = readPageCount(safeFs);
  if (pageCount instanceof Error) return pageCount;

  const designSystemRelPath = designFilePath(DESIGN_SYSTEM_MANIFEST_RELPATH);
  const hasDesignSystem = probeLeaf(safeFs, designSystemRelPath);
  if (hasDesignSystem instanceof Error)
    return new FormatTwoScanError({
      artifact: designSystemRelPath,
      code: "DESIGN_SYSTEM_PROBE_UNREADABLE",
      reason: hasDesignSystem.message,
      cause: hasDesignSystem,
    });

  return {
    formatVersion: FORMAT_TWO_PROJECT_VERSION,
    projectId: decoded.data.project_id,
    name: decoded.data.name,
    createdAt: decoded.data.created_at,
    targetStack: decoded.data.target_stack satisfies TargetStack,
    pageCount,
    hasDesignSystem,
  };
}

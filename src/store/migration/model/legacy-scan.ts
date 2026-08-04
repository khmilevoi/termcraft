import * as errore from "errore";
import { z } from "zod";

import { pageSlugSchema } from "entities/page";
import type { PageSlug } from "entities/page";
import { rfc3339UtcSchema } from "infrastructure/clock";
import { canonicalUuidv7Schema } from "infrastructure/uuid";
import { FsAccessError, isNotFound } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";
import { PROJECT_MANIFEST_FILENAME, TARGET_STACKS, parseToml, readFormatVersion } from "store/toml";
import type { TargetStack } from "store/toml";

import type { LegacyPageV1, LegacyProjectV1 } from "../types";

/** The format-1 layout's own version number. Named, not inlined: every check below is about THIS. */
export const LEGACY_PROJECT_FORMAT_VERSION = 1;

/** What went wrong reading a version-1 project. `code` is the branch, not a message fragment. */
export type LegacyScanCodeV1 =
  | "MANIFEST_UNREADABLE"
  | "MANIFEST_SHAPE"
  | "NOT_VERSION_1"
  | "PAGE_SOURCE_MISSING"
  | "PAGE_SOURCE_UNREADABLE";

/**
 * A version-1 project could not be read well enough to migrate it. Every branch names the artifact
 * it failed on, so the user sees which file blocked the offer rather than a generic refusal.
 */
export class LegacyScanError extends errore.createTaggedError({
  name: "LegacyScanError",
  message: "cannot read the version-1 project at $artifact [$code]: $reason",
}) {}

/**
 * The RETIRED format-1 `project.toml` schema. It lives here rather than in `store/toml` on purpose
 * (design-tree §12.1): shipping a version-1 decoder beside the version-2 one would put a
 * compatibility reader back into the live open path, and "no compatibility reader for it exists
 * anywhere in the system" is the property that keeps this change's blast radius small. Its ONLY
 * caller is `scanLegacyProject` below.
 *
 * `strictObject` — a stray key in a version-1 manifest is corruption exactly as it is in version 2.
 * `pages` is REQUIRED here: it is the whole reason format 1 existed, and a version-1 manifest
 * without it is not a version-1 manifest.
 */
const legacyProjectManifestSchema = z.strictObject({
  format_version: z.literal(LEGACY_PROJECT_FORMAT_VERSION),
  project_id: canonicalUuidv7Schema,
  name: z.string(),
  created_at: rfc3339UtcSchema,
  target_stack: z.enum(TARGET_STACKS),
  pages: z
    .array(pageSlugSchema)
    .refine((slugs) => new Set(slugs).size === slugs.length, "pages must not repeat a slug"),
});

/** `pages/<slug>/page.tsx` — the retired per-page source path. */
export function legacySourcePath(slug: PageSlug): string {
  return `pages/${slug}/page.tsx`;
}

/** `pages/<slug>/comments.jsonl` — the retired per-page pin log path. */
export function legacyPinsPath(slug: PageSlug): string {
  return `pages/${slug}/comments.jsonl`;
}

/** Whether a managed leaf exists, distinguishing "absent" from "could not tell". */
function probeLeaf(safeFs: SafeProjectFs, relPath: string): LegacyScanError | boolean {
  const stat = safeFs.stat(relPath);
  if (!(stat instanceof Error)) return true;
  if (stat instanceof FsAccessError && isNotFound(stat)) return false;
  return new LegacyScanError({
    artifact: relPath,
    code: "PAGE_SOURCE_UNREADABLE",
    reason: stat.message,
    cause: stat,
  });
}

/**
 * Read a version-1 project's portable facts (design-tree §12.2 track 1). This is the ONLY function
 * in the system that understands the retired layout; everything downstream consumes its result.
 *
 * `safeFs` MUST be opened on the `project-migration` root kind — the ordinary `project` grammar
 * refuses every `pages/**` path this function reads.
 */
export function scanLegacyProject(safeFs: SafeProjectFs): LegacyScanError | LegacyProjectV1 {
  const bytes = safeFs.readFile(PROJECT_MANIFEST_FILENAME);
  if (bytes instanceof Error)
    return new LegacyScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_UNREADABLE",
      reason: bytes.message,
      cause: bytes,
    });

  const parsed = parseToml(new TextDecoder().decode(bytes));
  if (parsed instanceof Error)
    return new LegacyScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_UNREADABLE",
      reason: "file is not valid TOML",
      cause: parsed,
    });

  // The version gate runs BEFORE the field schema, exactly as `decodeProjectManifest` orders its
  // own: a format-2 file handed to this scanner must be reported as "not version 1", never as a
  // pile of shape complaints about fields format 2 legitimately dropped.
  const version = readFormatVersion(parsed.value);
  if (version !== LEGACY_PROJECT_FORMAT_VERSION)
    return new LegacyScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "NOT_VERSION_1",
      reason: `format_version is ${version ?? "missing or non-integer"}, not 1`,
    });

  const decoded = legacyProjectManifestSchema.safeParse(parsed.value);
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    return new LegacyScanError({
      artifact: PROJECT_MANIFEST_FILENAME,
      code: "MANIFEST_SHAPE",
      reason: `${issue?.path.join(".") ?? "SHAPE"}: ${issue?.message ?? "invalid input"}`,
      cause: decoded.error,
    });
  }

  const pages: LegacyPageV1[] = [];
  for (const slug of decoded.data.pages) {
    const sourcePath = legacySourcePath(slug);
    const sourcePresent = probeLeaf(safeFs, sourcePath);
    if (sourcePresent instanceof Error) return sourcePresent;
    // A listed page with no file on disk stops the migration. The alternative — dropping it —
    // would silently delete a page the user's manifest says exists, and the backup would not
    // contain it either.
    if (!sourcePresent)
      return new LegacyScanError({
        artifact: sourcePath,
        code: "PAGE_SOURCE_MISSING",
        reason: `project.toml lists page "${slug}" but its source file does not exist`,
      });

    const pinsPath = legacyPinsPath(slug);
    const pinsPresent = probeLeaf(safeFs, pinsPath);
    if (pinsPresent instanceof Error) return pinsPresent;
    pages.push({
      slug,
      legacySourcePath: sourcePath,
      legacyPinsPath: pinsPresent ? pinsPath : null,
    });
  }

  return {
    formatVersion: LEGACY_PROJECT_FORMAT_VERSION,
    projectId: decoded.data.project_id,
    name: decoded.data.name,
    createdAt: decoded.data.created_at,
    targetStack: decoded.data.target_stack satisfies TargetStack,
    pages,
  };
}

import * as errore from "errore";
import { z } from "zod";

import { pageSlugSchema } from "entities/page";

import { PAGES_MANIFEST_SCHEMA_VERSION } from "../types";
import type { PageEntryV1, PagesManifestV1 } from "../types";

/**
 * `design/pages.json` could not be read as a manifest (design §4's fatal list): invalid JSON,
 * a bad shape, an unknown field, an invalid or duplicate slug, a malformed `entry`, or a
 * `requestedActivePage` naming an unlisted slug. Returned as a value; the Gate turns it into
 * a fatal `manifest`-kind `GateError` (Task 10) and the project store into a failure DTO.
 */
export class PagesManifestInvalidError extends errore.createTaggedError({
  name: "PagesManifestInvalidError",
  message: "design/pages.json is invalid [$code]: $reason",
}) {}

/**
 * A tree-relative `entry` path. Deliberately stricter than "any string": it must be
 * relative, forward-slash, non-empty, and free of `.`/`..` segments — `resolveDesignSpecifier`
 * (`./specifier.ts`) owns `..` handling for IMPORT specifiers, but a manifest entry is a
 * stored address and normalizing one would let two different manifests name the same file.
 * A backslash is rejected outright rather than translated: the tree's on-disk paths are
 * produced by joining these components, and silently accepting `\` would make the same
 * manifest mean different things on Windows and elsewhere.
 */
const entryPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\\"), { error: "`entry` must use forward slashes" })
  .refine((value) => !value.startsWith("/"), { error: "`entry` must be relative to design/" })
  .refine((value) => !/^[A-Za-z]:/.test(value), { error: "`entry` must not be a drive path" })
  .refine((value) => !value.includes("//"), { error: "`entry` must not contain an empty segment" })
  .refine(
    (value) =>
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { error: "`entry` must not contain `.` or `..` segments" },
  );

const pageEntrySchema = z.strictObject({
  slug: pageSlugSchema,
  entry: entryPathSchema,
});

const pagesManifestSchema = z.strictObject({
  schemaVersion: z.literal(PAGES_MANIFEST_SCHEMA_VERSION),
  pages: z.array(pageEntrySchema),
  requestedActivePage: pageSlugSchema.nullish(),
});

function invalid(code: string, reason: string): PagesManifestInvalidError {
  return new PagesManifestInvalidError({ code, reason });
}

/** Maps the first Zod issue onto the tagged error, mirroring `store/toml`'s decoder. */
function fromZod(error: z.ZodError): PagesManifestInvalidError {
  const issue = error.issues[0];
  const code = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "SHAPE";
  return invalid(code, issue?.message ?? "invalid input");
}

/**
 * Parse and validate `design/pages.json` (design §4). Structural validation is Zod's; the two
 * cross-field rules — a duplicate slug, and a `requestedActivePage` naming an unlisted slug —
 * are checked here because they span array elements. `entry` RESOLUTION against the real tree
 * is deliberately NOT checked here: this function never sees the tree. That check is
 * `findUnresolvedEntries` below, called by whoever holds the inventory.
 */
export function decodePagesManifest(text: string): PagesManifestInvalidError | PagesManifestV1 {
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => cause,
  });
  if (parsed instanceof Error) return invalid("JSON_PARSE", `not valid JSON: ${parsed.message}`);

  const result = pagesManifestSchema.safeParse(parsed);
  if (!result.success) return fromZod(result.error);

  const seen = new Set<string>();
  for (const page of result.data.pages) {
    if (seen.has(page.slug))
      return invalid("DUPLICATE_SLUG", `"${page.slug}" is a duplicate slug, already listed`);
    seen.add(page.slug);
  }

  const requested = result.data.requestedActivePage ?? null;
  if (requested !== null && !seen.has(requested))
    return invalid("ACTIVE_NOT_LISTED", `requestedActivePage "${requested}" is not in \`pages\``);

  return {
    schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
    pages: result.data.pages,
    requestedActivePage: requested,
  };
}

/**
 * Serialize a manifest deterministically: field order fixed, two-space indent, trailing
 * newline. Byte-determinism matters because the manifest is a tree file whose SHA-256 feeds
 * `treeRevision` — a re-encode that reordered keys would invalidate every cache for nothing.
 */
export function encodePagesManifest(manifest: PagesManifestV1): string {
  const body = {
    schemaVersion: manifest.schemaVersion,
    pages: manifest.pages.map((page) => ({ slug: page.slug, entry: page.entry })),
    ...(manifest.requestedActivePage === null
      ? {}
      : { requestedActivePage: manifest.requestedActivePage }),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The entries whose `entry` names no file in the tree (design §4: "It must resolve to a real
 * file inside the tree"). Separated from {@link decodePagesManifest} because it needs the
 * inventory the decoder never sees; the Gate calls both in sequence (Task 10).
 */
export function findUnresolvedEntries(input: {
  readonly manifest: PagesManifestV1;
  readonly has: (relPath: string) => boolean;
}): readonly PageEntryV1[] {
  return input.manifest.pages.filter((page) => !input.has(page.entry));
}

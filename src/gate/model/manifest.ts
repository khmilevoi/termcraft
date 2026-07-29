import {
  DESIGN_DIRNAME,
  PAGES_MANIFEST_RELPATH,
  decodePagesManifest,
  findUnresolvedEntries,
} from "entities/design-tree";
import type { PageEntryV1, PagesManifestInvalidError } from "entities/design-tree";

import type { GateError, ManifestSlice } from "../types";

/** `design/pages.json`'s project-relative path, as it appears in every manifest-kind `GateError.file`. */
const MANIFEST_FILE = `${DESIGN_DIRNAME}/${PAGES_MANIFEST_RELPATH}`;

/** What the manifest-slice check needs: the raw `pages.json` text + the tree's file inventory. */
export interface ManifestScanInput {
  /** The raw `pages.json` bytes as UTF-8 text. */
  readonly manifestText: string;
  /** Every tree-relative path present in the staged `design/` tree (entry resolution's universe). */
  readonly treePaths: readonly string[];
}

/** The manifest slice + any fatal manifest errors. `slice` is non-null only when there are none. */
export interface ManifestScanResult {
  readonly errors: readonly GateError[];
  readonly slice: ManifestSlice | null;
}

function manifestError(code: string, message: string): GateError {
  return { kind: "manifest", code, message, file: MANIFEST_FILE };
}

/** Maps a decode-time rejection onto one fatal `GateError`, reusing the decoder's own code. */
function fromDecodeError(error: PagesManifestInvalidError): GateError {
  return manifestError(String(error.code), error.message);
}

/** One `MANIFEST_ENTRY_UNRESOLVED` fatal per entry that names no file in the tree. */
function unresolvedEntryError(page: PageEntryV1): GateError {
  return manifestError(
    "MANIFEST_ENTRY_UNRESOLVED",
    `page "${page.slug}"'s entry "${page.entry}" does not resolve to a file in the design tree`,
  );
}

/**
 * The manifest-slice check (design §4, §8 step 1): `design/pages.json` decodes — schema,
 * duplicate slugs, and `requestedActivePage` membership are `decodePagesManifest`'s own job,
 * NOT re-implemented here — and every `entry` resolves to a real file in the staged tree
 * (`findUnresolvedEntries`, also not re-implemented here). This function only composes the
 * two and maps their outcomes onto `GateError`s; it holds no validation rules of its own.
 *
 * A manifest that fails to decode reports exactly ONE fatal `manifest`-kind `GateError` —
 * `decodePagesManifest` itself stops at the first problem, so there is never more than one to
 * report. Because the broken thing IS the manifest, not a page, that error's `file` is
 * `design/pages.json` itself; there is no page to attribute it to.
 *
 * Two different slugs are legal even when they name the SAME `entry` (design §4: "`entry` is
 * a value rather than a path convention", and the fatal list names a duplicate SLUG, never a
 * duplicate entry) — two identities rendering the same component is ordinary, not an error.
 * What is checked is resolution, not uniqueness, of `entry`: an `entry` unlisted-elsewhere is
 * fine (a shared module like `lib/theme.ts` has no manifest entry at all and that is normal),
 * an `entry` that resolves to no tree file is fatal.
 */
export function checkManifestSlice(input: ManifestScanInput): ManifestScanResult {
  const manifest = decodePagesManifest(input.manifestText);
  if (manifest instanceof Error) return { errors: [fromDecodeError(manifest)], slice: null };

  const present = new Set(input.treePaths);
  const unresolved = findUnresolvedEntries({ manifest, has: (relPath) => present.has(relPath) });
  if (unresolved.length > 0) return { errors: unresolved.map(unresolvedEntryError), slice: null };

  return {
    errors: [],
    slice: { pages: manifest.pages, active: manifest.requestedActivePage },
  };
}

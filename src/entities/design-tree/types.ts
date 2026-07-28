import type { PageSlug } from "entities/page";

/** The canonical tree's directory name under `.termcraft/` and inside a turn workspace (design §3). */
export const DESIGN_DIRNAME = "design";

/** The manifest's TREE-relative path (design §3, §4) — `design/pages.json` project-relative. */
export const PAGES_MANIFEST_RELPATH = "pages.json";

/** The only shipped manifest schema version (design §4). */
export const PAGES_MANIFEST_SCHEMA_VERSION = 1;

/** One file of the authored tree: its TREE-relative path and the SHA-256 of its exact bytes. */
export interface DesignFileEntryV1 {
  readonly relPath: string;
  readonly sha256: string;
}

/**
 * The whole `design/` inventory. `files` is sorted by `relPath` with a plain `<` comparison
 * over the UTF-16 code units — the same order `computeTreeRevision`/`computeClosureHash`
 * fold in, so a caller that builds an inventory in a different order produces a different
 * hash for identical content. Build it with {@link createDesignTreeInventory}.
 */
export interface DesignTreeInventoryV1 {
  readonly files: readonly DesignFileEntryV1[];
}

/** One `pages.json` entry: the page's immutable identity and the tree-relative file that is its entry point. */
export interface PageEntryV1 {
  readonly slug: PageSlug;
  readonly entry: string;
}

/** The parsed, validated `design/pages.json` (design §4). Array order IS page order. */
export interface PagesManifestV1 {
  readonly schemaVersion: typeof PAGES_MANIFEST_SCHEMA_VERSION;
  readonly pages: readonly PageEntryV1[];
  /** `null` when the manifest requests no particular active page. */
  readonly requestedActivePage: PageSlug | null;
}

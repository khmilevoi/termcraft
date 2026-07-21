import * as errore from "errore";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { GateError } from "../types";

/**
 * The staging manifest slice `pages.json` (master §6.2): the ordered page slugs the
 * agent left in the turn workspace plus an optional requested active slug (a
 * machine-local effect, not a portable manifest field). This is the parsed, validated
 * form — produced only when every manifest-slice check passes.
 */
export interface ManifestSlice {
  readonly pages: readonly PageSlug[];
  readonly active: PageSlug | null;
}

/** What the manifest-slice check needs: the raw `pages.json` text + the slugs actually staged. */
export interface ManifestScanInput {
  /** The raw `pages.json` bytes as UTF-8 text. */
  readonly manifestText: string;
  /** The slugs of the page files (`pages/<slug>.tsx`) actually present in staging. */
  readonly presentSlugs: readonly PageSlug[];
}

/** The manifest slice + any fatal manifest errors. `slice` is non-null only when there are none. */
export interface ManifestScanResult {
  readonly errors: GateError[];
  readonly slice: ManifestSlice | null;
}

function manifestError(code: string, message: string): GateError {
  return { kind: "manifest", code, message, file: "pages.json" };
}

/**
 * Structurally parse `pages.json` into `{ pages, active? }` shape, or a fatal parse
 * error. Returns a discriminated result — a `GateError` is a plain data object, NOT an
 * `Error` instance, so the caller checks the `error` key, never `instanceof Error`.
 */
function parseManifest(text: string): { error: GateError } | { pages: unknown; active: unknown } {
  const parsed = errore.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => cause,
  });
  if (parsed instanceof Error)
    return {
      error: manifestError("MANIFEST_PARSE", `pages.json is not valid JSON: ${parsed.message}`),
    };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      error: manifestError(
        "MANIFEST_SHAPE",
        "pages.json must be a JSON object with a `pages` array",
      ),
    };
  }
  const record = parsed as Record<string, unknown>;
  return { pages: record["pages"], active: record["active"] };
}

/**
 * The manifest-slice checks (master §6.3 step 1): `pages.json` parses, every slug
 * matches the mask, the list is a permutation of the pages actually staged, and the
 * optional requested active page exists in the list. Any violation is a fatal
 * `manifest`-kind `GateError`; a fully valid slice is returned parsed. This is a
 * TURN-level check (over the whole staging set), distinct from the per-page gate — the
 * Kernel runs it once per turn before the per-page stages.
 */
export function checkManifestSlice(input: ManifestScanInput): ManifestScanResult {
  const parsed = parseManifest(input.manifestText);
  if ("error" in parsed) return { errors: [parsed.error], slice: null };

  const errors: GateError[] = [];

  if (!Array.isArray(parsed.pages)) {
    errors.push(
      manifestError("MANIFEST_SHAPE", "pages.json `pages` must be an array of slug strings"),
    );
    return { errors, slice: null };
  }
  if (parsed.active !== undefined && typeof parsed.active !== "string") {
    errors.push(
      manifestError("MANIFEST_SHAPE", "pages.json `active`, when present, must be a slug string"),
    );
  }

  const slugs: PageSlug[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.pages) {
    if (typeof entry !== "string") {
      errors.push(manifestError("MANIFEST_SHAPE", "every `pages` entry must be a slug string"));
      continue;
    }
    const slug = parsePageSlug(entry);
    if (slug instanceof Error) {
      errors.push(manifestError("MANIFEST_INVALID_SLUG", slug.message));
      continue;
    }
    if (seen.has(slug)) {
      errors.push(
        manifestError("MANIFEST_DUPLICATE_SLUG", `pages.json lists "${slug}" more than once`),
      );
      continue;
    }
    seen.add(slug);
    slugs.push(slug);
  }

  // Permutation check: the listed slugs must be exactly the staged page files — no
  // manifest entry without a staged page, and no staged page missing from the manifest.
  const present = new Set<string>(input.presentSlugs);
  for (const slug of slugs) {
    if (!present.has(slug))
      errors.push(
        manifestError(
          "MANIFEST_UNKNOWN_PAGE",
          `pages.json lists "${slug}" but no such page file is staged`,
        ),
      );
  }
  for (const slug of input.presentSlugs) {
    if (!seen.has(slug))
      errors.push(
        manifestError("MANIFEST_MISSING_PAGE", `staged page "${slug}" is absent from pages.json`),
      );
  }

  let active: PageSlug | null = null;
  if (typeof parsed.active === "string") {
    const parsedActive = parsePageSlug(parsed.active);
    if (parsedActive instanceof Error) {
      errors.push(
        manifestError("MANIFEST_INVALID_SLUG", `pages.json \`active\`: ${parsedActive.message}`),
      );
    } else if (!seen.has(parsedActive)) {
      errors.push(
        manifestError(
          "MANIFEST_ACTIVE_NOT_LISTED",
          `pages.json \`active\` "${parsedActive}" is not in the pages list`,
        ),
      );
    } else {
      active = parsedActive;
    }
  }

  if (errors.length > 0) return { errors, slice: null };
  return { errors, slice: { pages: slugs, active } };
}

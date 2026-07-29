import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import { checkManifestSlice } from "./manifest";

const TREE = ["pages.json", "pages/dashboard.tsx", "screens/calendar/index.tsx", "lib/theme.ts"];

describe("checkManifestSlice", () => {
  test("accepts a manifest whose entries all resolve, preserving order", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [
          { slug: "dashboard", entry: "pages/dashboard.tsx" },
          { slug: "calendar", entry: "screens/calendar/index.tsx" },
        ],
        requestedActivePage: "dashboard",
      }),
      treePaths: TREE,
    });
    expect(result.errors).toEqual([]);
    expect(result.slice?.pages.map((page) => page.slug)).toEqual([
      "dashboard",
      "calendar",
    ] as PageSlug[]);
    expect(result.slice?.active).toBe("dashboard" as PageSlug);
  });

  test("an entry that does not resolve is a fatal MANIFEST_ENTRY_UNRESOLVED", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "dashboard", entry: "pages/missing.tsx" }],
      }),
      treePaths: TREE,
    });
    expect(result.slice).toBeNull();
    expect(result.errors[0]?.code).toBe("MANIFEST_ENTRY_UNRESOLVED");
    expect(result.errors[0]?.file).toBe("design/pages.json");
  });

  test("a file no entry names is NOT a manifest error — shared modules are legal", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "dashboard", entry: "pages/dashboard.tsx" }],
      }),
      treePaths: TREE, // lib/theme.ts and screens/… are unlisted and that is fine
    });
    expect(result.errors).toEqual([]);
  });

  test("two entries pointing at the same file are legal — the slug is the identity", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [
          { slug: "a", entry: "pages/dashboard.tsx" },
          { slug: "b", entry: "pages/dashboard.tsx" },
        ],
      }),
      treePaths: TREE,
    });
    expect(result.errors).toEqual([]);
  });

  test("every decoder rejection surfaces as one fatal manifest error", () => {
    const result = checkManifestSlice({ manifestText: "{", treePaths: TREE });
    expect(result.slice).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("manifest");
  });

  test("a semantic decode rejection (duplicate slug), not just a JSON-parse failure, composes through the same decode path", () => {
    // Distinct from the JSON-parse case above: this manifest is syntactically valid JSON and
    // matches the object shape — it fails `decodePagesManifest`'s own cross-field duplicate-slug
    // check, which this stage must not re-implement, only relay as one fatal `GateError`.
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [
          { slug: "about", entry: "views/landing.tsx" },
          { slug: "about", entry: "views/other.tsx" },
        ],
      }),
      treePaths: TREE,
    });
    expect(result.slice).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("manifest");
    expect(result.errors[0]?.code).toBe("DUPLICATE_SLUG");
    expect(result.errors[0]?.file).toBe("design/pages.json");
  });

  // ---- Pinned beyond the brief's own cases (task-10 "Your Job" step 3) ----

  test("an entry naming a real file on disk outside the design tree is still MANIFEST_ENTRY_UNRESOLVED — resolution is scoped to treePaths, never the real filesystem", () => {
    // "package.json" genuinely exists on disk (repo root, outside design/) but is not a
    // member of `treePaths`. A resolver that fell back to `fs.existsSync`/`Bun.file` instead
    // of `has()` would wrongly accept this; the manifest lookup must not touch real I/O at all.
    const result = checkManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "about", entry: "package.json" }],
      }),
      treePaths: TREE,
    });
    expect(result.slice).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("MANIFEST_ENTRY_UNRESOLVED");
    expect(result.errors[0]?.file).toBe("design/pages.json");
  });

  test("an empty pages array is a valid, empty slice", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({ schemaVersion: 1, pages: [] }),
      treePaths: TREE,
    });
    expect(result.errors).toEqual([]);
    expect(result.slice).toEqual({ pages: [], active: null });
  });

  test("a valid but non-canonically formatted pages.json (compact, reordered keys) still decodes", () => {
    // Raw bytes, not run through `encodePagesManifest` (Task 1's own two-space-indent, fixed
    // field order encoder) — a decoder that were accidentally sensitive to formatting would
    // pass every test seeded through its own encoder and still be broken on a real agent turn.
    const raw =
      '{"requestedActivePage":"about","pages":[{"entry":"views/landing.tsx","slug":"about"}],"schemaVersion":1}';
    const result = checkManifestSlice({
      manifestText: raw,
      treePaths: [...TREE, "views/landing.tsx"],
    });
    expect(result.errors).toEqual([]);
    expect(result.slice?.pages.map((page) => page.slug)).toEqual(["about"] as PageSlug[]);
    expect(result.slice?.active).toBe("about" as PageSlug);
  });
});

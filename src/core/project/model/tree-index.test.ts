import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import type { DesignTreeReader } from "core/ports";
import {
  createFakeDesignStore,
  createFakeDesignStoreForPages,
  createFakeGateRunner,
} from "core/ports/fakes";
import type { DesignTreeFileSeedV1, FakeGateRunner } from "core/ports/fakes";
import type { Sha256Hex } from "core/protocol";
import { createSeedManifest, renderDesignSystemManifest } from "entities/design-system";
import {
  PAGES_MANIFEST_RELPATH,
  PAGES_MANIFEST_SCHEMA_VERSION,
  computeSourceHash,
  decodePagesManifest,
  encodePagesManifest,
} from "entities/design-tree";
import { type PageSlug, parsePageSlug } from "entities/page";

import { readCanonicalTreeIndex } from "./tree-index";

/**
 * `core/project/model/tree-index.ts` — the ONE tree read every non-turn path shares (design-tree
 * phase 2, Task 5). The scenarios below are the module's whole reason to exist: two pages sharing
 * a module must both be hashed, an edit to that shared module must move BOTH their hashes, an
 * unprovable closure must read `null` and carry its diagnostic, and the revision must be an
 * identity rather than a directory-walk artifact.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const HOME = slug("home");
const ABOUT = slug("about");
const HOME_ENTRY = "screens/home/main.tsx";
const ABOUT_ENTRY = "screens/about/main.tsx";
const SHARED = "lib/theme.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A two-page tree whose pages both import {@link SHARED} — the shape design §7 exists for. */
function sharedModuleTree(themeSource: string) {
  return createFakeDesignStoreForPages({
    pages: [
      {
        pageSlug: HOME,
        bytes: bytes(`import { TITLE } from "../../lib/theme";\n`),
        entry: HOME_ENTRY,
      },
      {
        pageSlug: ABOUT,
        bytes: bytes(`import { TITLE } from "../../lib/theme";\n`),
        entry: ABOUT_ENTRY,
      },
    ],
    extraFiles: new Map([[SHARED, { bytes: bytes(themeSource) }]]),
  });
}

/** Both pages' closures, exactly as the whole-tree pass resolves them. */
function queueBothClosures(gateRunner: FakeGateRunner): void {
  gateRunner.queueRunTreeResult({
    errors: [],
    warnings: [],
    closures: [
      { slug: HOME, files: [SHARED, HOME_ENTRY] },
      { slug: ABOUT, files: [SHARED, ABOUT_ENTRY] },
    ],
  });
}

/**
 * A reader whose `listTree()` answers with an ARBITRARY listing — the one thing
 * `createFakeDesignStoreForPages` cannot express, since its own `listTree()` is sorted and
 * backed by a `Map` (so it can neither reorder nor repeat a path). Every other method is the
 * real fake's.
 */
function withListing(
  reader: DesignTreeReader,
  listing: readonly {
    readonly relPath: string;
    readonly sha256: Sha256Hex;
    readonly size: number;
  }[],
): DesignTreeReader {
  return {
    readTreeFile: (relPath) => reader.readTreeFile(relPath),
    readManifest: () => reader.readManifest(),
    listTree: async () => listing,
  };
}

/** An empty, otherwise-valid `pages.json` — the design-system tests below aren't about page identity. */
const PAGES_JSON = encodePagesManifest({
  schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
  pages: [],
  requestedActivePage: null,
});

/**
 * A minimal `{ designReader, gateRunner }` pair for the design-system tests below: every entry in
 * `files` becomes a real tree file (`listTree()` names it, `readTreeFile()` serves it), and
 * `pages.json`'s bytes decode into the fake's manifest — the same two-map split
 * `createFakeDesignStore` itself uses, just built from raw text instead of `FakeDesignPageV1`
 * seeds, since these tests are about `system/design-system.json`, not page identity.
 */
function depsWithTree(files: Readonly<Record<string, string>>): {
  readonly designReader: DesignTreeReader;
  readonly gateRunner: FakeGateRunner;
} {
  const manifestText = files[PAGES_MANIFEST_RELPATH];
  if (manifestText === undefined) throw new Error("depsWithTree fixture bug: no pages.json given");
  const manifest = decodePagesManifest(manifestText);
  if (manifest instanceof Error) throw manifest;

  const fileMap = new Map<string, DesignTreeFileSeedV1>(
    Object.entries(files).map(([relPath, text]) => [
      relPath,
      { bytes: new TextEncoder().encode(text) },
    ]),
  );
  return {
    designReader: createFakeDesignStore({ manifest, files: fileMap }),
    gateRunner: createFakeGateRunner(),
  };
}

describe("readCanonicalTreeIndex", () => {
  test("two pages sharing a module both get a closure hash, and the two differ", async () => {
    await context.start(async () => {
      const designReader = sharedModuleTree('export const TITLE = "v1";\n');
      const gateRunner = createFakeGateRunner();
      queueBothClosures(gateRunner);

      const index = await wrap(readCanonicalTreeIndex({ designReader, gateRunner }));
      if ("code" in index) throw new Error(`expected an index, got ${index.safeMessage}`);

      const home = index.closureHashOf(HOME);
      const about = index.closureHashOf(ABOUT);
      expect(home).not.toBeNull();
      expect(about).not.toBeNull();
      // Different closures (different entry files) must never fold to the same digest.
      expect(home).not.toBe(about);
      // ONE pass for the whole read, never one per page.
      expect(gateRunner.calls.filter((call) => call.method === "runTree")).toHaveLength(1);
    });
  });

  test("editing ONLY the shared module moves BOTH pages' closure hashes", async () => {
    await context.start(async () => {
      const before = createFakeGateRunner();
      queueBothClosures(before);
      const first = await wrap(
        readCanonicalTreeIndex({
          designReader: sharedModuleTree('export const TITLE = "v1";\n'),
          gateRunner: before,
        }),
      );
      if ("code" in first) throw new Error(`expected an index, got ${first.safeMessage}`);

      const after = createFakeGateRunner();
      queueBothClosures(after);
      const second = await wrap(
        readCanonicalTreeIndex({
          // The pages' own bytes are byte-identical across the two trees; only `lib/theme.ts`
          // moved. A hash keyed on the entry file alone would report "nothing changed" here.
          designReader: sharedModuleTree('export const TITLE = "v2";\n'),
          gateRunner: after,
        }),
      );
      if ("code" in second) throw new Error(`expected an index, got ${second.safeMessage}`);

      expect(second.closureHashOf(HOME)).not.toBe(first.closureHashOf(HOME));
      expect(second.closureHashOf(ABOUT)).not.toBe(first.closureHashOf(ABOUT));
      // And the whole-tree revision moved with it.
      expect(second.treeRevision).not.toBe(first.treeRevision);
    });
  });

  test("a page whose closure the pass could not prove is `null`, and its error is carried", async () => {
    await context.start(async () => {
      const designReader = sharedModuleTree('export const TITLE = "v1";\n');
      const gateRunner = createFakeGateRunner();
      gateRunner.queueRunTreeResult({
        errors: [
          {
            kind: "import",
            code: "IMPORT_DENIED",
            message: 'the design tree may not import "node:fs"',
            file: ABOUT_ENTRY,
            blockedPages: [ABOUT],
          },
        ],
        warnings: [],
        // The port's own contract: a page whose closure was not PROVED is ABSENT from
        // `closures`, never carried with a truncated file list.
        closures: [{ slug: HOME, files: [SHARED, HOME_ENTRY] }],
      });

      const index = await wrap(readCanonicalTreeIndex({ designReader, gateRunner }));
      if ("code" in index) throw new Error(`expected an index, got ${index.safeMessage}`);

      expect(index.closureHashOf(HOME)).not.toBeNull();
      // `null` means "cannot compute" — never "unchanged".
      expect(index.closureHashOf(ABOUT)).toBeNull();
      expect(index.errors).toHaveLength(1);
      expect(index.errors[0]?.code).toBe("IMPORT_DENIED");
      expect(index.errors[0]?.blockedPages).toEqual([ABOUT]);
    });
  });

  test("a `listTree()` that enumerates in a different ORDER produces the SAME treeRevision", async () => {
    await context.start(async () => {
      const backing = sharedModuleTree('export const TITLE = "v1";\n');
      const listing = await wrap(backing.listTree());
      if ("code" in listing) throw new Error("fixture bug: listTree failed");
      expect(listing.length).toBeGreaterThan(1);

      const forward = await wrap(
        readCanonicalTreeIndex({
          designReader: withListing(backing, listing),
          gateRunner: createFakeGateRunner(),
        }),
      );
      if ("code" in forward) throw new Error(`expected an index, got ${forward.safeMessage}`);

      const reversed = await wrap(
        readCanonicalTreeIndex({
          designReader: withListing(backing, [...listing].reverse()),
          gateRunner: createFakeGateRunner(),
        }),
      );
      if ("code" in reversed) throw new Error(`expected an index, got ${reversed.safeMessage}`);

      // A directory walk's order is a filesystem detail; the revision is an identity.
      expect(reversed.treeRevision).toBe(forward.treeRevision);
      expect(reversed.inventory.files).toEqual(forward.inventory.files);
    });
  });

  test("a duplicate relPath in `listTree()` is a typed failure, never a collapsed entry", async () => {
    await context.start(async () => {
      const backing = sharedModuleTree('export const TITLE = "v1";\n');
      const listing = await wrap(backing.listTree());
      if ("code" in listing) throw new Error("fixture bug: listTree failed");
      const duplicated = listing.find((file) => file.relPath === SHARED);
      if (duplicated === undefined) throw new Error("fixture bug: the shared module is unlisted");

      const result = await wrap(
        readCanonicalTreeIndex({
          designReader: withListing(backing, [
            ...listing,
            { ...duplicated, sha256: computeSourceHash(bytes("something else")) },
          ]),
          gateRunner: createFakeGateRunner(),
        }),
      );

      if (!("code" in result)) throw new Error("expected a refusal for a duplicated relPath");
      expect(result.safeMessage).toContain(SHARED);
      expect(result.details.relPath).toBe(SHARED);
    });
  });
});

describe("readCanonicalTreeIndex — the design system (design-systems §4.6)", () => {
  test("decodes system/design-system.json when the tree carries one", async () => {
    await context.start(async () => {
      const index = await wrap(
        readCanonicalTreeIndex(
          depsWithTree({
            "pages.json": PAGES_JSON,
            "system/design-system.json": renderDesignSystemManifest(
              createSeedManifest({ kitApiVersion: 1 }),
            ),
          }),
        ),
      );
      if ("code" in index) throw new Error(`expected an index, got ${index.safeMessage}`);
      expect(index.designSystem?.id).toBe("default");
      expect(index.designSystem?.defaultTheme).toBe("dark-default");
    });
  });

  test("a tree with no design system reports null, with no failure", async () => {
    await context.start(async () => {
      const index = await wrap(readCanonicalTreeIndex(depsWithTree({ "pages.json": PAGES_JSON })));
      if ("code" in index) throw new Error(`expected an index, got ${index.safeMessage}`);
      expect(index.designSystem).toBeNull();
    });
  });

  test("an UNDECODABLE manifest reports null rather than refusing the read (P4 D7)", async () => {
    // An agent turn that writes a malformed manifest must stay able to repair it on the NEXT turn;
    // refusing here would make the project unopenable and unfixable. The Gate is the enforcement
    // point, and it does not need this decode to succeed first.
    await context.start(async () => {
      const index = await wrap(
        readCanonicalTreeIndex(
          depsWithTree({ "pages.json": PAGES_JSON, "system/design-system.json": "{ not json" }),
        ),
      );
      if ("code" in index) throw new Error(`expected an index, got ${index.safeMessage}`);
      expect(index.designSystem).toBeNull();
    });
  });
});

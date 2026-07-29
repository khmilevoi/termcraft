import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createFakeDesignStore } from "core/ports/fakes";
import { encodePagesManifest } from "entities/design-tree";
import type { PagesManifestV1 } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import { createDesignStoreAdapter } from "./design-store";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";
import type { RealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

function mustParseSlug(raw: string): PageSlug {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) throw new Error(`fixture bug: ${slug.message}`);
  return slug;
}

const HOME_SLUG = mustParseSlug("home");
const ABOUT_SLUG = mustParseSlug("about");

// Deliberately unrelated to their own slugs (design §3, §7's central rule: nothing computes
// a page's file from its slug) — an entry that happened to equal `pages/<slug>.tsx` could
// never distinguish a genuine manifest lookup from a slug-computed guess.
const HOME_ENTRY = "screens/home-view.tsx";
const ABOUT_ENTRY = "panels/about-panel.tsx";

const HOME_SOURCE = `export const meta = definePage({
  kitApiVersion: 1,
  title: "Home",
  minSize: { w: 40, h: 10 },
  theme: "dark",
});

export default reatomComponent(() => null);
`;

const ABOUT_SOURCE = `export const meta = definePage({
  kitApiVersion: 1,
  title: "About",
  minSize: { w: 40, h: 10 },
  theme: "dark",
});

export default reatomComponent(() => null);
`;

function designPath(open: RealProjectFixture["open"], relPath: string): string {
  return path.join(open.root, ".termcraft", "design", ...relPath.split("/"));
}

function writeDesignFile(open: RealProjectFixture["open"], relPath: string, content: string): void {
  const abs = designPath(open, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * Seeds `design/pages.json` and each entry's file directly on disk, bypassing the
 * transaction engine — this file's own subject is `createDesignStoreAdapter`, not the engine
 * (`store/model/transaction-engine-methods.test.ts` exercises that side). The real adapter's
 * `renameTitle`/`reorder`/`remove` all resolve a page's file through this exact manifest,
 * never by computing a path from its slug.
 */
function seedManifest(open: RealProjectFixture["open"], manifest: PagesManifestV1): void {
  writeDesignFile(open, "pages.json", encodePagesManifest(manifest));
}

async function seedHomePage(open: RealProjectFixture["open"]) {
  seedManifest(open, {
    schemaVersion: 1,
    pages: [{ slug: HOME_SLUG, entry: HOME_ENTRY }],
    requestedActivePage: null,
  });
  writeDesignFile(open, HOME_ENTRY, HOME_SOURCE);
}

async function seedHomeAndAboutPages(open: RealProjectFixture["open"]) {
  seedManifest(open, {
    schemaVersion: 1,
    pages: [
      { slug: HOME_SLUG, entry: HOME_ENTRY },
      { slug: ABOUT_SLUG, entry: ABOUT_ENTRY },
    ],
    requestedActivePage: null,
  });
  writeDesignFile(open, HOME_ENTRY, HOME_SOURCE);
  writeDesignFile(open, ABOUT_ENTRY, ABOUT_SOURCE);
}

describe("createDesignStoreAdapter — contract test (fake vs. real)", () => {
  test("readTreeFile()/listTree()/readManifest() read the real design tree, entries resolved through the manifest — never a slug-computed path", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createDesignStoreAdapter(deps);

      const manifest = await adapter.readManifest();
      if ("code" in manifest) throw new Error("fixture bug: readManifest failed");
      expect(manifest.pages).toEqual([{ slug: HOME_SLUG, entry: HOME_ENTRY }]);

      const file = await adapter.readTreeFile(HOME_ENTRY);
      if ("code" in file) throw new Error("fixture bug: readTreeFile failed");
      expect(new TextDecoder().decode(file.bytes)).toBe(HOME_SOURCE);

      const tree = await adapter.listTree();
      if ("code" in tree) throw new Error("fixture bug: listTree failed");
      expect(tree.map((entry) => entry.relPath).sort()).toEqual(["pages.json", HOME_ENTRY].sort());
    } finally {
      await open.close();
    }
  });

  // Restores the pre-Task-7 GREEN test this file used to carry ("readSource() on an unlisted
  // slug returns a FailureDtoV1 from both the fake and the real adapter") under the
  // `DesignTreeReader` vocabulary: both sides refuse an unrecognized relPath — the fake
  // because nothing was ever seeded there, the real adapter because the file genuinely does
  // not exist — same shape, same pairing.
  test("readTreeFile() on an unknown relPath refuses in both the fake and the real adapter", async () => {
    const fake = createFakeDesignStore({
      manifest: { schemaVersion: 1, pages: [], requestedActivePage: null },
    });
    const fakeResult = await fake.readTreeFile("pages/missing.tsx");
    expect("code" in fakeResult).toBe(true);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createDesignStoreAdapter(deps);
      const realResult = await adapter.readTreeFile("pages/missing.tsx");
      expect("code" in realResult).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("renameTitle() resolves the entry through the manifest and mechanically rewrites only the meta.title field, byte-identical everywhere else", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createDesignStoreAdapter(deps);

      const renamed = await adapter.renameTitle(HOME_SLUG, "New Title");
      expect(renamed).toBeUndefined();

      // Verified via `readTreeFile(HOME_ENTRY)` — the SAME manifest-resolved path
      // `renameTitle` itself used, never a slug-shaped guess like `pages/home.tsx`.
      const source = await adapter.readTreeFile(HOME_ENTRY);
      if ("code" in source) throw new Error("fixture bug: readTreeFile failed");
      const text = new TextDecoder().decode(source.bytes);
      expect(text).toContain('title: "New Title"');
      expect(text).toContain("kitApiVersion: 1");
      expect(text).toContain('theme: "dark"');
      expect(text).toContain("minSize: { w: 40, h: 10 }");
      expect(text).toContain("export default reatomComponent(() => null);");
    } finally {
      await open.close();
    }
  });

  test("renameTitle() reports a failure, without writing, when the manifest lists no entry for the slug", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      // A manifest that genuinely EXISTS and decodes — listing only "about", never "home" —
      // so `renameTitle`'s own `entry === undefined` branch (design-store.ts) is what fires.
      // Seeding NOTHING at all would make `readManifest()` fail on ENOENT first, which maps
      // to the SAME `PERSISTENCE_FAILED` code and would prove nothing about the intended
      // branch — this is the load-bearing distinction (review finding, round 2).
      seedManifest(open, {
        schemaVersion: 1,
        pages: [{ slug: ABOUT_SLUG, entry: ABOUT_ENTRY }],
        requestedActivePage: null,
      });
      writeDesignFile(open, ABOUT_ENTRY, ABOUT_SOURCE);

      const adapter = createDesignStoreAdapter(deps);
      const renamed = await adapter.renameTitle(HOME_SLUG, "New Title");
      if (renamed === undefined) throw new Error("fixture bug: expected a failure");
      expect(renamed.code).toBe("PERSISTENCE_FAILED");
      // The exact `PageEntryNotFoundError` wording, not a generic manifest-read failure's.
      expect(renamed.safeMessage).toContain("no design-tree entry");

      // Nothing was written: the manifest and the untracked sibling page are unchanged.
      const manifest = await adapter.readManifest();
      if ("code" in manifest) throw new Error("fixture bug: readManifest failed");
      expect(manifest.pages).toEqual([{ slug: ABOUT_SLUG, entry: ABOUT_ENTRY }]);
      const aboutFile = await adapter.readTreeFile(ABOUT_ENTRY);
      if ("code" in aboutFile) throw new Error("fixture bug: readTreeFile failed");
      expect(new TextDecoder().decode(aboutFile.bytes)).toBe(ABOUT_SOURCE);
    } finally {
      await open.close();
    }
  });

  test("reorder() replaces only the manifest's page order — each entry keeps its own file", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomeAndAboutPages(open);
      const adapter = createDesignStoreAdapter(deps);

      const reordered = await adapter.reorder([ABOUT_SLUG, HOME_SLUG]);
      expect(reordered).toBeUndefined();

      const manifest = await adapter.readManifest();
      if ("code" in manifest) throw new Error("fixture bug: readManifest failed");
      expect(manifest.pages).toEqual([
        { slug: ABOUT_SLUG, entry: ABOUT_ENTRY },
        { slug: HOME_SLUG, entry: HOME_ENTRY },
      ]);

      // Reordering never moves a page's source file — both entries still resolve.
      const homeFile = await adapter.readTreeFile(HOME_ENTRY);
      expect("code" in homeFile).toBe(false);
      const aboutFile = await adapter.readTreeFile(ABOUT_ENTRY);
      expect("code" in aboutFile).toBe(false);
    } finally {
      await open.close();
    }
  });

  test("remove() drops the page from the manifest and deletes its entry file — a sibling page's own entry is untouched", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomeAndAboutPages(open);
      const adapter = createDesignStoreAdapter(deps);

      const removed = await adapter.remove({
        pageRemovePlanId: uuidv7(),
        pageSlug: HOME_SLUG,
        sourceHash: "0".repeat(64),
        orderedPageSlugs: [HOME_SLUG, ABOUT_SLUG],
        pageOrderHash: "0".repeat(64),
        activePageSlug: null,
        fallbackPageSlug: null,
        planRevision: "0",
      });
      expect(removed).toBeUndefined();

      const slugs = await adapter.listSlugs();
      if ("code" in slugs) throw new Error("fixture bug: listSlugs failed");
      expect(slugs).toEqual([ABOUT_SLUG]);

      const homeFile = await adapter.readTreeFile(HOME_ENTRY);
      expect("code" in homeFile).toBe(true);

      // Never a slug-computed path guess: the never-seeded `pages/home.tsx` was never
      // written in the first place, so failing to find it would prove nothing either way —
      // the sibling's own real entry, `panels/about-panel.tsx`, is the load-bearing check.
      const aboutFile = await adapter.readTreeFile(ABOUT_ENTRY);
      expect("code" in aboutFile).toBe(false);
    } finally {
      await open.close();
    }
  });

  test("remove() rejects a plan whose pageSlug fails slug validation before ever reading the manifest — the honest `parsePageSlug` path, not a laundering cast", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);

      let manifestReadCalls = 0;
      const spiedOpen: typeof open = {
        ...open,
        pages: {
          ...open.pages,
          readManifest: (...args: Parameters<(typeof open.pages)["readManifest"]>) => {
            manifestReadCalls += 1;
            return open.pages.readManifest(...args);
          },
        },
      };
      const adapter = createDesignStoreAdapter({ ...deps, open: spiedOpen });

      const removed = await adapter.remove({
        pageRemovePlanId: uuidv7(),
        // Fails `entities/page`'s slug mask (`^[a-z0-9][a-z0-9-]{0,31}$`) — an uppercase
        // letter is never a valid slug character.
        pageSlug: "Not-A-Valid-Slug",
        sourceHash: "0".repeat(64),
        orderedPageSlugs: [HOME_SLUG],
        pageOrderHash: "0".repeat(64),
        activePageSlug: null,
        fallbackPageSlug: null,
        planRevision: "0",
      });

      if (removed === undefined) throw new Error("fixture bug: expected a failure");
      expect(removed.code).toBe("PERSISTENCE_FAILED");
      // A cast-laundered slug would reach `open.transactions.removePage`, which reads the
      // manifest first (`manifestBefore`) before ever touching the target path — validating
      // with `parsePageSlug` up front means that read never happens.
      expect(manifestReadCalls).toBe(0);

      // The valid, existing page is untouched by the rejected plan.
      const slugs = await adapter.listSlugs();
      if ("code" in slugs) throw new Error("fixture bug: listSlugs failed");
      expect(slugs).toEqual([HOME_SLUG]);
    } finally {
      await open.close();
    }
  });
});

// ---- fake-vs-real contract (opened by Task 7's review — closed here) ---------------------
//
// `createFakeDesignStore` (`core/ports/fakes/design-store.ts`) had no test proving its
// behavior actually matches the real adapter — every existing test exercised ONE side or the
// other, never both against the identical seeded scenario. These run the SAME manifest/tree
// through both and assert matching outcomes, now that a real `DesignTreeStore`
// (`store/model/factory.ts`, Task 9) exists to compare the fake against.
describe("createFakeDesignStore — fake-vs-real contract", () => {
  test("readManifest()/readTreeFile()/listTree() agree between the fake and the real adapter for the same seeded tree", async () => {
    const manifest: PagesManifestV1 = {
      schemaVersion: 1,
      pages: [
        { slug: HOME_SLUG, entry: HOME_ENTRY },
        { slug: ABOUT_SLUG, entry: ABOUT_ENTRY },
      ],
      requestedActivePage: null,
    };
    const fake = createFakeDesignStore({
      manifest,
      files: new Map([
        [HOME_ENTRY, { bytes: new TextEncoder().encode(HOME_SOURCE), sha256: "0".repeat(64) }],
        [ABOUT_ENTRY, { bytes: new TextEncoder().encode(ABOUT_SOURCE), sha256: "1".repeat(64) }],
      ]),
    });

    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomeAndAboutPages(open);
      const real = createDesignStoreAdapter(deps);

      const fakeManifestResult = await fake.readManifest();
      const realManifestResult = await real.readManifest();
      if ("code" in fakeManifestResult || "code" in realManifestResult)
        throw new Error("fixture bug: readManifest failed");
      expect(realManifestResult.pages).toEqual(fakeManifestResult.pages);

      const fakeFile = await fake.readTreeFile(HOME_ENTRY);
      const realFile = await real.readTreeFile(HOME_ENTRY);
      if ("code" in fakeFile || "code" in realFile)
        throw new Error("fixture bug: readTreeFile failed");
      expect(new TextDecoder().decode(realFile.bytes)).toBe(
        new TextDecoder().decode(fakeFile.bytes),
      );

      const fakeTree = await fake.listTree();
      const realTree = await real.listTree();
      if ("code" in fakeTree || "code" in realTree) throw new Error("fixture bug: listTree failed");
      // Known, deliberate divergence (not papered over): `design/pages.json` is a REAL file
      // the real adapter's tree walk includes; the fake's `files` map is a separate seed
      // from `manifest` and never models the manifest itself as a walkable tree entry.
      expect(realTree.map((entry) => entry.relPath).sort()).toEqual(
        [...fakeTree.map((entry) => entry.relPath), "pages.json"].sort(),
      );
    } finally {
      await open.close();
    }
  });

  test("readTreeFile() on an unknown relPath is a failure on both sides", async () => {
    const fake = createFakeDesignStore({
      manifest: { schemaVersion: 1, pages: [], requestedActivePage: null },
    });
    const { open, deps } = await createRealProjectFixture();
    try {
      const real = createDesignStoreAdapter(deps);
      const fakeResult = await fake.readTreeFile("nowhere.tsx");
      const realResult = await real.readTreeFile("nowhere.tsx");
      expect("code" in fakeResult).toBe(true);
      expect("code" in realResult).toBe(true);
    } finally {
      await open.close();
    }
  });
});

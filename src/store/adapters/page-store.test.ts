import { afterEach, describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import { createPageStoreAdapter } from "./page-store";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

function mustParseSlug(raw: string): PageSlug {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) throw new Error(`fixture bug: ${slug.message}`);
  return slug;
}

const HOME_SLUG = mustParseSlug("home");

const HOME_SOURCE = `export const meta = definePage({
  kitApiVersion: 1,
  title: "Home",
  minSize: { w: 40, h: 10 },
  theme: "dark",
});

export default reatomComponent(() => null);
`;

/** Seeds one canonical page directly through the transaction engine — the same shape `renamePageTitle`/`reorderPages`/`removePage` all consume. */
async function seedHomePage(open: Awaited<ReturnType<typeof createRealProjectFixture>>["open"]) {
  const manifestBefore = await open.manifest.read();
  if (manifestBefore instanceof Error) throw new Error(`fixture bug: ${manifestBefore.message}`);

  const written = await open.transactions.renamePageTitle({
    transactionId: uuidv7(),
    actionId: uuidv7(),
    pageSlug: HOME_SLUG,
    newBytes: new TextEncoder().encode(HOME_SOURCE),
    createdAt: "2026-07-24T00:00:00.000Z",
  });
  if (written instanceof Error) throw new Error(`fixture bug: ${written.message}`);

  const reordered = await open.transactions.reorderPages({
    transactionId: uuidv7(),
    actionId: uuidv7(),
    manifestBefore,
    orderedSlugs: [HOME_SLUG],
    createdAt: "2026-07-24T00:00:00.000Z",
  });
  if (reordered instanceof Error) throw new Error(`fixture bug: ${reordered.message}`);
}

// NOTE (plan Task 7, adjacent-file fix beyond the brief's own file list): `PageReader`
// (`readSource`/`listSlugs`) is gone from `core/ports`, replaced by `DesignTreeReader`
// (`readTreeFile`/`listTree`/`readManifest`) — `store/adapters/page-store.ts`'s real
// adapter has no `DesignTreeStore` to delegate to yet (Task 9's job) and honestly refuses
// every `DesignTreeReader` call instead of fabricating a tree read; see that file's own
// header. These reader-shaped tests are rewritten to assert exactly that refusal rather
// than exercising a read this codebase cannot honestly perform yet. The `PageMutations`
// tests below are otherwise UNCHANGED — same test names, same already-known Task 9 debt
// (red-debt.md), just no longer crashing the whole file on load (Bun aborts a file on a
// missing named export; this file's own `createFakePageStore` import was one).
describe("createPageStoreAdapter — contract test (fake vs. real)", () => {
  test("readTreeFile()/listTree()/readManifest() honestly refuse — DesignTreeStore is not wired yet (Task 9)", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createPageStoreAdapter(deps);

      const file = await adapter.readTreeFile("pages/home.tsx");
      expect("code" in file).toBe(true);

      const tree = await adapter.listTree();
      expect("code" in tree).toBe(true);

      const manifest = await adapter.readManifest();
      expect("code" in manifest).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("renameTitle() mechanically rewrites only the meta.title field, byte-identical everywhere else", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createPageStoreAdapter(deps);

      const renamed = await adapter.renameTitle(HOME_SLUG, "New Title");
      expect(renamed).toBeUndefined();

      // Verified via the store's own `PageStore.readSource` directly — `DesignTreeReader`'s
      // new `readTreeFile` cannot honestly perform this read yet (see this file's header).
      const source = await open.pages.readSource(HOME_SLUG);
      if (source instanceof Error) throw new Error(`fixture bug: ${source.message}`);
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

  test("reorder() replaces only the portable page order", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createPageStoreAdapter(deps);

      const reordered = await adapter.reorder([HOME_SLUG]);
      expect(reordered).toBeUndefined();
      const slugs = await open.pages.listSlugs();
      if (slugs instanceof Error) throw new Error(`fixture bug: ${slugs.message}`);
      expect(slugs).toEqual([HOME_SLUG]);
    } finally {
      await open.close();
    }
  });

  test("remove() drops the page from the manifest and deletes its source", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createPageStoreAdapter(deps);

      const removed = await adapter.remove({
        pageRemovePlanId: uuidv7(),
        pageSlug: HOME_SLUG,
        sourceHash: "0".repeat(64),
        orderedPageSlugs: [HOME_SLUG],
        pageOrderHash: "0".repeat(64),
        activePageSlug: null,
        fallbackPageSlug: null,
        planRevision: "0",
      });
      expect(removed).toBeUndefined();

      const slugs = await open.pages.listSlugs();
      if (slugs instanceof Error) throw new Error(`fixture bug: ${slugs.message}`);
      expect(slugs).toEqual([]);

      const source = await open.pages.readSource(HOME_SLUG);
      expect(source instanceof Error).toBe(true);
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
        manifest: {
          ...open.manifest,
          read: (...args: Parameters<(typeof open.manifest)["read"]>) => {
            manifestReadCalls += 1;
            return open.manifest.read(...args);
          },
        },
      };
      const adapter = createPageStoreAdapter({ ...deps, open: spiedOpen });

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
      const slugs = await open.pages.listSlugs();
      if (slugs instanceof Error) throw new Error(`fixture bug: ${slugs.message}`);
      expect(slugs).toEqual([HOME_SLUG]);
    } finally {
      await open.close();
    }
  });
});

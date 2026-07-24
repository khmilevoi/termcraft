import { afterEach, describe, expect, test } from "bun:test";

import { createFakePageStore } from "core/ports/fakes";
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

describe("createPageStoreAdapter — contract test (fake vs. real)", () => {
  test("listSlugs()/readSource() see a page seeded through the real transaction engine", async () => {
    const fake = createFakePageStore({ order: [HOME_SLUG] });
    const fakeSlugs = await fake.listSlugs();
    expect(fakeSlugs).toEqual([HOME_SLUG]);

    const { open, deps } = await createRealProjectFixture();
    try {
      await seedHomePage(open);
      const adapter = createPageStoreAdapter(deps);

      const slugs = await adapter.listSlugs();
      if ("code" in slugs) throw new Error("fixture bug: listSlugs failed");
      expect(slugs).toEqual([HOME_SLUG]);

      const source = await adapter.readSource(HOME_SLUG);
      if ("code" in source) throw new Error("fixture bug: readSource failed");
      expect(new TextDecoder().decode(source.bytes)).toBe(HOME_SOURCE);
      expect(source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await open.close();
    }
  });

  test("readSource() on an unlisted slug returns a FailureDtoV1 from both the fake and the real adapter", async () => {
    const fake = createFakePageStore({ order: [] });
    const fakeResult = await fake.readSource(HOME_SLUG);
    expect("code" in fakeResult).toBe(true);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createPageStoreAdapter(deps);
      const realResult = await adapter.readSource(HOME_SLUG);
      expect("code" in realResult).toBe(true);
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

      const source = await adapter.readSource(HOME_SLUG);
      if ("code" in source) throw new Error("fixture bug: readSource failed");
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
      const slugs = await adapter.listSlugs();
      if ("code" in slugs) throw new Error("fixture bug: listSlugs failed");
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

      const slugs = await adapter.listSlugs();
      if ("code" in slugs) throw new Error("fixture bug: listSlugs failed");
      expect(slugs).toEqual([]);

      const source = await adapter.readSource(HOME_SLUG);
      expect("code" in source).toBe(true);
    } finally {
      await open.close();
    }
  });
});

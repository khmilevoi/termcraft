import { describe, expect, test } from "bun:test";

import type { FailureDtoV1, PageRemovePlanV1 } from "core/protocol";
import type { PagesManifestV1 } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import { createFakeDesignStore, fakeDesignTreeFile } from "./design-store";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "design tree unreadable",
  details: {},
};

function manifestOf(order: readonly PageSlug[]): PagesManifestV1 {
  return {
    schemaVersion: 1,
    pages: order.map((pageSlug) => ({ slug: pageSlug, entry: `pages/${pageSlug}.tsx` })),
    requestedActivePage: null,
  };
}

function plan(pageSlug: PageSlug): PageRemovePlanV1 {
  return {
    pageRemovePlanId: "plan-1",
    pageSlug,
    sourceHash: "a".repeat(64),
    orderedPageSlugs: [pageSlug],
    pageOrderHash: "b".repeat(64),
    activePageSlug: null,
    fallbackPageSlug: null,
    planRevision: "0",
  };
}

describe("createFakeDesignStore", () => {
  test("readManifest() returns the constructed manifest, array order IS page order", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([slug("home"), slug("about")]) });
    const result = await store.readManifest();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.pages.map((entry) => entry.slug)).toEqual([slug("home"), slug("about")]);
  });

  test("readTreeFile() returns a seeded tree file's bytes by TREE-relative path", async () => {
    const file = fakeDesignTreeFile("pages/home.tsx");
    const store = createFakeDesignStore({
      manifest: manifestOf([slug("home")]),
      files: new Map([["pages/home.tsx", file]]),
    });
    const result = await store.readTreeFile("pages/home.tsx");
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.bytes).toBe(file.bytes);
  });

  test("readTreeFile() on an untracked relPath returns an intrinsic not-found failure", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([]) });
    const result = await store.readTreeFile("pages/missing.tsx");
    expect("code" in result).toBe(true);
  });

  test("listTree() enumerates every seeded file as (relPath, sha256, size), sorted by relPath", async () => {
    const store = createFakeDesignStore({
      manifest: manifestOf([slug("home")]),
      files: new Map([
        ["pages/home.tsx", fakeDesignTreeFile("home")],
        ["lib/theme.ts", fakeDesignTreeFile("theme")],
      ]),
    });
    const result = await store.listTree();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.map((entry) => entry.relPath)).toEqual(["lib/theme.ts", "pages/home.tsx"]);
    expect(result.every((entry) => entry.size > 0)).toBe(true);
  });

  test("reorder() replaces the manifest order verbatim, never inventing or dropping a slug", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([slug("home"), slug("about")]) });
    await store.reorder([slug("about"), slug("home")]);
    const result = await store.readManifest();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.pages.map((entry) => entry.slug)).toEqual([slug("about"), slug("home")]);
  });

  test("remove() drops the page from the manifest order and its own entry file", async () => {
    const store = createFakeDesignStore({
      manifest: manifestOf([slug("home"), slug("about")]),
      files: new Map([
        ["pages/home.tsx", fakeDesignTreeFile("home")],
        ["pages/about.tsx", fakeDesignTreeFile("about")],
      ]),
    });
    await store.remove(plan(slug("about")));
    const result = await store.readManifest();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.pages.map((entry) => entry.slug)).toEqual([slug("home")]);
    expect("code" in (await store.readTreeFile("pages/about.tsx"))).toBe(true);
  });

  test("failNext() queues one failure for the named method", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([slug("home")]) });
    store.failNext("renameTitle", FAILURE);
    const first = await store.renameTitle(slug("home"), "New title");
    expect(first).toEqual(FAILURE);
    const second = await store.renameTitle(slug("home"), "New title");
    expect(second).toBeUndefined();
  });

  test("renameTitle() records the title without touching the manifest or the tree file's own bytes", async () => {
    const store = createFakeDesignStore({
      manifest: manifestOf([slug("home")]),
      files: new Map([["pages/home.tsx", fakeDesignTreeFile("home")]]),
    });
    await store.renameTitle(slug("home"), "Home page");
    expect(store.titles.get(slug("home"))).toBe("Home page");
    const file = await store.readTreeFile("pages/home.tsx");
    if ("code" in file) throw new Error("unexpected failure");
    expect(new TextDecoder().decode(file.bytes)).toBe("home");
  });

  test("records calls in order with their arguments", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([slug("home")]) });
    await store.readManifest();
    await store.renameTitle(slug("home"), "Home page");
    expect(store.calls.map((c) => c.method)).toEqual(["readManifest", "renameTitle"]);
    expect(store.calls[1]).toMatchObject({
      method: "renameTitle",
      pageSlug: slug("home"),
      title: "Home page",
    });
  });
});

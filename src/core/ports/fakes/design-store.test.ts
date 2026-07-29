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

// `entry` here happens to equal `pages/${slug}.tsx` for CONVENIENCE only, in tests that never
// assert anything about which relPath a slug resolves to. Do not use this for a test that is
// meant to prove a lookup goes through `manifest.entry` rather than a slug-shaped guess — the
// coincidence would make such a test pass identically either way. Use
// {@link manifestWithEntries} for that (review finding, promoted 3).
function manifestOf(order: readonly PageSlug[]): PagesManifestV1 {
  return {
    schemaVersion: 1,
    pages: order.map((pageSlug) => ({ slug: pageSlug, entry: `pages/${pageSlug}.tsx` })),
    requestedActivePage: null,
  };
}

/**
 * Builds a manifest from explicit `(slug, entry)` pairs, deliberately unrelated to each
 * other where a test needs to prove the plan's central rule: nothing computes a page's file
 * from its slug (design §3, §7). See {@link manifestOf}'s own doc for why that helper cannot
 * be used for this.
 */
function manifestWithEntries(
  entries: readonly { readonly slug: PageSlug; readonly entry: string }[],
): PagesManifestV1 {
  return {
    schemaVersion: 1,
    pages: entries.map(({ slug: pageSlug, entry }) => ({ slug: pageSlug, entry })),
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

  // Review finding, promoted 4 (and its own Task 9 follow-up): the port's own doc
  // (`design-store.ts`) says reorder() takes "the exact permutation of already-listed slugs
  // — never a subset or an added/removed identity." THREE cases pinned, not merely "both
  // directions" as an earlier version of this comment overclaimed: an order naming a slug
  // the manifest never listed, an order that is a genuine subset (silently dropping a
  // tracked slug), and a DUPLICATED slug (`[home, home]` against `[home, about]` — same
  // length as the manifest, so the length check alone lets it through and would otherwise
  // silently drop `about`, the exact class of bug this whole guard exists to eliminate). All
  // three leave the manifest completely untouched.
  describe("reorder() refuses rather than silently dropping/inventing/duplicating an identity", () => {
    test("refuses an order naming an unknown pageSlug", async () => {
      const store = createFakeDesignStore({ manifest: manifestOf([slug("home")]) });
      const result = await store.reorder([slug("home"), slug("about")]);
      if (result === undefined) throw new Error("expected reorder() to refuse this order");
      expect(result.code).toBe("PERSISTENCE_FAILED");
      const after = await store.readManifest();
      if ("code" in after) throw new Error("unexpected failure");
      expect(after.pages.map((entry) => entry.slug)).toEqual([slug("home")]); // untouched
    });

    test("refuses a genuine subset — never silently drops a tracked slug", async () => {
      const store = createFakeDesignStore({ manifest: manifestOf([slug("home"), slug("about")]) });
      const result = await store.reorder([slug("home")]);
      if (result === undefined) throw new Error("expected reorder() to refuse this order");
      expect(result.code).toBe("PERSISTENCE_FAILED");
      const after = await store.readManifest();
      if ("code" in after) throw new Error("unexpected failure");
      expect(after.pages.map((entry) => entry.slug)).toEqual([slug("home"), slug("about")]); // untouched
    });

    test("refuses a duplicated pageSlug — same length as the manifest, but never a silent drop of the other tracked slug", async () => {
      const store = createFakeDesignStore({ manifest: manifestOf([slug("home"), slug("about")]) });
      const result = await store.reorder([slug("home"), slug("home")]);
      if (result === undefined) throw new Error("expected reorder() to refuse this order");
      expect(result.code).toBe("PERSISTENCE_FAILED");
      const after = await store.readManifest();
      if ("code" in after) throw new Error("unexpected failure");
      expect(after.pages.map((entry) => entry.slug)).toEqual([slug("home"), slug("about")]); // untouched, `about` not dropped
    });
  });

  // Review finding, promoted 3: `about`'s entry is DELIBERATELY unrelated to its slug
  // (`views/landing.tsx`, never `pages/about.tsx`) — proves `remove()` deletes by reading
  // `manifest.entry`, never by guessing a slug-shaped path (the plan's central rule, design
  // §3, §7). A slug-computed implementation would try to delete the never-seeded
  // `pages/about.tsx`, silently no-op, and leave `views/landing.tsx` behind — this assertion
  // catches exactly that.
  test("remove() drops the page from the manifest order and its own entry file, looked up through the manifest — never a slug-computed path", async () => {
    const store = createFakeDesignStore({
      manifest: manifestWithEntries([
        { slug: slug("home"), entry: "pages/home.tsx" },
        { slug: slug("about"), entry: "views/landing.tsx" },
      ]),
      files: new Map([
        ["pages/home.tsx", fakeDesignTreeFile("home")],
        ["views/landing.tsx", fakeDesignTreeFile("about")],
      ]),
    });
    await store.remove(plan(slug("about")));
    const result = await store.readManifest();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.pages.map((entry) => entry.slug)).toEqual([slug("home")]);
    expect("code" in (await store.readTreeFile("views/landing.tsx"))).toBe(true); // the real entry file is gone
    expect("code" in (await store.readTreeFile("pages/about.tsx"))).toBe(true); // never existed either way
  });

  test("failNext() queues one failure for the named method", async () => {
    const store = createFakeDesignStore({ manifest: manifestOf([slug("home")]) });
    store.failNext("renameTitle", FAILURE);
    const first = await store.renameTitle(slug("home"), "New title");
    expect(first).toEqual(FAILURE);
    const second = await store.renameTitle(slug("home"), "New title");
    expect(second).toBeUndefined();
  });

  // KNOWN FAKE-FIDELITY GAP (review finding, promoted 5 — see `FakeDesignStore.titles`'s own
  // doc comment for the full rationale): the REAL adapter (`store/adapters/page-store.ts`)
  // mechanically rewrites the entry file's `meta.title` bytes; this fake only records the
  // title in `titles` and leaves `files` byte-for-byte untouched. This test PINS that gap —
  // it does NOT prove renameTitle() is byte-correct, only that this fake's own (deliberately
  // limited) behavior stays what it currently is. A "rename then read the file and expect the
  // new title" test would pass against the real adapter and give a FALSE green here.
  test("renameTitle() records the title without touching the manifest or the tree file's own bytes (fake-fidelity gap, not a real-adapter guarantee)", async () => {
    const store = createFakeDesignStore({
      manifest: manifestOf([slug("home")]),
      files: new Map([["pages/home.tsx", fakeDesignTreeFile("home")]]),
    });
    await store.renameTitle(slug("home"), "Home page");
    expect(store.titles.get(slug("home"))).toBe("Home page");
    const file = await store.readTreeFile("pages/home.tsx");
    if ("code" in file) throw new Error("unexpected failure");
    expect(new TextDecoder().decode(file.bytes)).toBe("home"); // unchanged — the known gap
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

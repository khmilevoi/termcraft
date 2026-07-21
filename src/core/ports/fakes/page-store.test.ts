import { describe, expect, test } from "bun:test";

import type { FailureDtoV1, PageRemovePlanV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import { createFakePageStore } from "./page-store";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "page unreadable",
  details: {},
};

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

describe("createFakePageStore", () => {
  test("listSlugs() returns the constructed manifest order", async () => {
    const store = createFakePageStore({ order: [slug("home"), slug("about")] });
    const result = await store.listSlugs();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result).toEqual([slug("home"), slug("about")]);
  });

  test("readSource() returns a seeded page's bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const store = createFakePageStore({
      order: [slug("home")],
      sources: new Map([[slug("home"), { bytes, sourceHash: "c".repeat(64) }]]),
    });
    const result = await store.readSource(slug("home"));
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.bytes).toBe(bytes);
  });

  test("readSource() on an untracked slug returns an intrinsic not-found failure", async () => {
    const store = createFakePageStore({ order: [] });
    const result = await store.readSource(slug("missing"));
    expect("code" in result).toBe(true);
  });

  test("reorder() replaces the manifest order verbatim", async () => {
    const store = createFakePageStore({ order: [slug("home"), slug("about")] });
    await store.reorder([slug("about"), slug("home")]);
    const result = await store.listSlugs();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result).toEqual([slug("about"), slug("home")]);
  });

  test("remove() drops the page from the manifest order", async () => {
    const store = createFakePageStore({ order: [slug("home"), slug("about")] });
    await store.remove(plan(slug("about")));
    const result = await store.listSlugs();
    if ("code" in result) throw new Error("unexpected failure");
    expect(result).toEqual([slug("home")]);
  });

  test("failNext() queues one failure for the named method", async () => {
    const store = createFakePageStore({ order: [slug("home")] });
    store.failNext("renameTitle", FAILURE);
    const first = await store.renameTitle(slug("home"), "New title");
    expect(first).toEqual(FAILURE);
    const second = await store.renameTitle(slug("home"), "New title");
    expect(second).toBeUndefined();
  });

  test("records calls in order with their arguments", async () => {
    const store = createFakePageStore({ order: [slug("home")] });
    await store.listSlugs();
    await store.renameTitle(slug("home"), "Home page");
    expect(store.calls.map((c) => c.method)).toEqual(["listSlugs", "renameTitle"]);
    expect(store.calls[1]).toMatchObject({
      method: "renameTitle",
      pageSlug: slug("home"),
      title: "Home page",
    });
  });
});

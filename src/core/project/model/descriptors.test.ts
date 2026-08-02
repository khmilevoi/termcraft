import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import { createFakeDesignStore } from "core/ports/fakes";
import { type PageDescriptorV1, type Sha256Hex, eventPayloadV1SchemaByKind } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";

import {
  buildPageDescriptorsChangedPayload,
  computePageDescriptorChanges,
  readPageEntrySource,
  readPageOrder,
} from "./descriptors";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const HASH_A = "a".repeat(64) as Sha256Hex;
const HASH_B = "b".repeat(64) as Sha256Hex;

function ready(pageSlug: PageSlug, sourceHash: Sha256Hex, title = "Title"): PageDescriptorV1 {
  return {
    status: "ready",
    pageSlug,
    sourceHash,
    title,
    minSize: { w: 80, h: 24 },
    theme: "default",
    kitApiVersion: 1,
  };
}

function invalid(pageSlug: PageSlug, sourceHash: Sha256Hex): PageDescriptorV1 {
  return {
    status: "invalid",
    pageSlug,
    sourceHash,
    error: { code: "SYNTAX", safeMessage: "bad module" },
  };
}

describe("computePageDescriptorChanges", () => {
  test("reports no changes for two identical, identically ordered lists", () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)];
    const after = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)];
    expect(computePageDescriptorChanges(before, after)).toEqual([]);
  });

  test('a page present only in `after` is "added" with a null beforeSourceHash', () => {
    const before = [ready(slug("home"), HASH_A)];
    const after = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "added",
      beforeSourceHash: null,
      afterSourceHash: HASH_B,
    });
  });

  test('a page present only in `before` is "removed" with a null afterSourceHash', () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)];
    const after = [ready(slug("home"), HASH_A)];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "removed",
      beforeSourceHash: HASH_B,
      afterSourceHash: null,
    });
  });

  test('a changed sourceHash for the same page is "updated" carrying both hashes', () => {
    const before = [ready(slug("home"), HASH_A)];
    const after = [ready(slug("home"), HASH_B)];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toEqual([
      {
        pageSlug: slug("home"),
        kind: "updated",
        beforeSourceHash: HASH_A,
        afterSourceHash: HASH_B,
      },
    ]);
  });

  test('a status flip (ready -> invalid) at the same hash is still "updated"', () => {
    const before = [ready(slug("home"), HASH_A)];
    const after = [invalid(slug("home"), HASH_A)];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toEqual([
      {
        pageSlug: slug("home"),
        kind: "updated",
        beforeSourceHash: HASH_A,
        afterSourceHash: HASH_A,
      },
    ]);
  });

  test('an unchanged page that moved position is "reordered", not "updated"', () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)];
    const after = [ready(slug("about"), HASH_B), ready(slug("home"), HASH_A)];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({
      pageSlug: slug("home"),
      kind: "reordered",
      beforeSourceHash: HASH_A,
      afterSourceHash: HASH_A,
    });
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "reordered",
      beforeSourceHash: HASH_B,
      afterSourceHash: HASH_B,
    });
  });

  test('a title-only change on a ready descriptor is "updated" even though the hash column is equal', () => {
    // title differs but callers always recompute sourceHash alongside title in practice;
    // this proves the comparison inspects the whole descriptor, not just sourceHash.
    const before = [ready(slug("home"), HASH_A, "Old title")];
    const after = [ready(slug("home"), HASH_A, "New title")];
    const changes = computePageDescriptorChanges(before, after);
    expect(changes).toEqual([
      {
        pageSlug: slug("home"),
        kind: "updated",
        beforeSourceHash: HASH_A,
        afterSourceHash: HASH_A,
      },
    ]);
  });
});

describe("buildPageDescriptorsChangedPayload", () => {
  test("assembles a schema-valid payload with the given reason, descriptors, and activePageSlug", () => {
    const before: readonly PageDescriptorV1[] = [];
    const after = [ready(slug("home"), HASH_A)];
    const payload = buildPageDescriptorsChangedPayload("project-open", before, after, slug("home"));
    if (payload instanceof Error) throw payload;
    expect(payload).toEqual(eventPayloadV1SchemaByKind["page.descriptorsChanged"].parse(payload));
    expect(payload.reason).toBe("project-open");
    expect(payload.descriptors).toEqual(after);
    expect(payload.activePageSlug).toBe(slug("home"));
    expect(payload.changes).toEqual([
      { pageSlug: slug("home"), kind: "added", beforeSourceHash: null, afterSourceHash: HASH_A },
    ]);
  });

  test("keeps the after list COMPLETE and in the exact given order, even with no changes", () => {
    const list = [ready(slug("b"), HASH_A), ready(slug("a"), HASH_B)];
    const payload = buildPageDescriptorsChangedPayload("external-refresh", list, list, null);
    if (payload instanceof Error) throw payload;
    expect(payload.descriptors).toEqual(list);
  });

  test("rejects a descriptor list with a duplicate pageSlug rather than silently accepting it", () => {
    const dup = [ready(slug("home"), HASH_A), ready(slug("home"), HASH_B)];
    const payload = buildPageDescriptorsChangedPayload("turn-apply", [], dup, null);
    expect(payload).toBeInstanceOf(Error);
  });
});

describe("readPageOrder / readPageEntrySource — the manifest is the only slug -> file binding", () => {
  const HOME = slug("home");
  /** Deliberately unlike `pages/<slug>.tsx`: a fixture whose entry is derivable from the slug cannot tell a manifest lookup apart from a path computation. */
  const HOME_ENTRY = "screens/landing/main.tsx";
  const HOME_BYTES = new TextEncoder().encode("export default function Home() {}");

  function storeWith(files: ReadonlyMap<string, { bytes: Uint8Array; sha256: Sha256Hex }>) {
    return createFakeDesignStore({
      manifest: {
        schemaVersion: 1,
        pages: [{ slug: HOME, entry: HOME_ENTRY }],
        requestedActivePage: null,
      },
      files,
    });
  }

  test("reads the entry the manifest names — never a path derived from the slug", async () => {
    await context.start(async () => {
      const store = storeWith(new Map([[HOME_ENTRY, { bytes: HOME_BYTES, sha256: HASH_A }]]));
      const source = await wrap(readPageEntrySource(store, HOME));
      if ("code" in source) throw new Error(`expected a source, got ${source.safeMessage}`);
      expect(source.relPath).toBe(HOME_ENTRY);
      expect(source.sourceHash).toBe(HASH_A);
      // The ONLY tree path it asked for was the manifest's own entry.
      expect(store.calls.filter((c) => c.method === "readTreeFile")).toEqual([
        { method: "readTreeFile", relPath: HOME_ENTRY },
      ]);
    });
  });

  test("a slug the manifest does not list is a typed refusal, never a speculative read", async () => {
    await context.start(async () => {
      const store = storeWith(new Map([[HOME_ENTRY, { bytes: HOME_BYTES, sha256: HASH_A }]]));
      const source = await wrap(readPageEntrySource(store, slug("ghost")));
      if (!("code" in source)) throw new Error("expected a refusal for an unlisted slug");
      expect(source.safeMessage).toContain('lists no entry for page "ghost"');
      expect(store.calls.some((c) => c.method === "readTreeFile")).toBe(false);
    });
  });

  test("a tree that does NOT name pages.json reads as an empty page order, not a failure", async () => {
    // The allowance the retired `PageReader.listSlugs()` carried ("`[]` for a project with no
    // `design/pages.json` yet ... never an error", `store/model/factory.ts`), preserved at the
    // one seam that lost it when task 14 retired that method's last caller. Without it,
    // `project.open` on a freshly created project blocks forever and the app never reaches
    // `ready` — measured: `src/entrypoint/model/smoke.test.ts` timed out on
    // `kernel.project.finishOpen`.
    await context.start(async () => {
      const store = storeWith(new Map());
      store.failNext("readManifest", {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "ENOENT: design/pages.json",
        details: {},
      });
      const order = await wrap(readPageOrder(store));
      expect(order).toEqual([]);
    });
  });

  test("a tree that DOES name pages.json propagates the read failure — the allowance never swallows a real one", async () => {
    // The valid-input companion to the row above, and the half that makes the allowance safe:
    // a corrupt-but-present manifest must still refuse, or a decode error would silently read
    // as "this project has no pages" and invite an agent to recreate every one of them.
    await context.start(async () => {
      const store = storeWith(
        new Map([["pages.json", { bytes: new TextEncoder().encode("{"), sha256: HASH_B }]]),
      );
      store.failNext("readManifest", {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "pages.json is not valid JSON",
        details: {},
      });
      const order = await wrap(readPageOrder(store));
      if (!("code" in order)) throw new Error("expected the decode failure to propagate");
      expect(order.safeMessage).toBe("pages.json is not valid JSON");
    });
  });

  test("a caller-supplied treePaths answers the same question without a second listTree()", async () => {
    await context.start(async () => {
      const store = storeWith(new Map());
      store.failNext("readManifest", {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "pages.json is not valid JSON",
        details: {},
      });
      const order = await wrap(readPageOrder(store, ["pages.json", HOME_ENTRY]));
      if (!("code" in order)) throw new Error("expected the decode failure to propagate");
      expect(store.calls.some((c) => c.method === "listTree")).toBe(false);
    });
  });
});

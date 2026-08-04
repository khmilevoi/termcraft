import { describe, expect, spyOn, test } from "bun:test";

import { context } from "@reatom/core";

import { reatomExportStateMachine } from "core/machines";
import type {
  ExportRenderPoolBoundsV1,
  ExportRenderPort,
  ExportRenderResultV1,
  ExportRenderTaskV1,
  RuntimeDeclarationBundleV1,
} from "core/ports";
import {
  createFakeDesignStoreForPages,
  createFakeExportRenderPort,
  createFakeProjectWriteCoordinator,
  createFakeRenderCache,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { computeClosureHash, computeSourceHash } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";

import type { ExportPageSnapshotV1, ExportSnapshotV1, ExportTreeFileV1 } from "../types";
import { buildExportRenderKey, runExportRendering } from "./render-jobs";
import { captureExportSnapshot } from "./snapshot";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function manualClock(startMs: number): Clock {
  return { now: () => new Date(startMs) };
}

// Task 7 fix round 1: `sourceHash` below was fabricated (`"a"`/`"b".repeat(64)`), unrelated to
// `bytes`, despite feeding both a design-store fake seed (below) and several direct assertions.
const HOME_BYTES = new Uint8Array([1]);
const ABOUT_BYTES = new Uint8Array([2]);
const HOME_SOURCE_HASH = computeSourceHash(HOME_BYTES);
const ABOUT_SOURCE_HASH = computeSourceHash(ABOUT_BYTES);

/**
 * A page's `closureHash` computed the SAME way `readCanonicalTreeIndex` computes it —
 * `computeClosureHash` over the closure's own `(relPath, sha256)` pairs — never a hand-picked
 * hex literal, which would just be a more convincing fabrication (the discipline
 * `HOME_SOURCE_HASH` above and `preview-export.test.ts`'s `HOME_CLOSURE_HASH` both follow).
 */
function closureHashOver(files: readonly (readonly [string, string])[]): string {
  const sha256Of = new Map(files);
  const hash = computeClosureHash({
    files: files.map(([relPath]) => relPath),
    sha256Of: (relPath) => sha256Of.get(relPath) ?? null,
  });
  if (hash === null)
    throw new Error("closureHashOver: every file handed in is present in its own lookup");
  return hash;
}

/**
 * A module BOTH pages import and NEITHER page's entry file is — the exact thing a render cache
 * keyed on the entry's own `sourceHash` could not see change (design-tree phase 2 Task 8).
 */
const SHARED_REL_PATH = "shared/palette.ts";
const SHARED_BEFORE_HASH = computeSourceHash(new TextEncoder().encode("export const accent = 1"));
const SHARED_AFTER_HASH = computeSourceHash(new TextEncoder().encode("export const accent = 2"));

// Bound as `string` constants rather than read back off the fixtures below: the interface types
// them `string | null`, which would make every assertion here nullable for no reason.
const HOME_CLOSURE_HASH = closureHashOver([
  ["pages/home.tsx", HOME_SOURCE_HASH],
  [SHARED_REL_PATH, SHARED_BEFORE_HASH],
]);
const ABOUT_CLOSURE_HASH = closureHashOver([
  ["pages/about.tsx", ABOUT_SOURCE_HASH],
  [SHARED_REL_PATH, SHARED_BEFORE_HASH],
]);
const ABOUT_CLOSURE_HASH_AFTER_SHARED_EDIT = closureHashOver([
  ["pages/about.tsx", ABOUT_SOURCE_HASH],
  [SHARED_REL_PATH, SHARED_AFTER_HASH],
]);

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  closureHash: HOME_CLOSURE_HASH,
  sourceHash: HOME_SOURCE_HASH,
  bytes: HOME_BYTES,
};

const ABOUT: ExportPageSnapshotV1 = {
  pageSlug: slug("about"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/about.tsx",
  expectedFiles: [{ relPath: "pages/about.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 1,
  minSize: { w: 200, h: 50 }, // larger than both standard sizes -> single-size ladder
  theme: "dark",
  kitApiVersion: 2,
  closureHash: ABOUT_CLOSURE_HASH,
  sourceHash: ABOUT_SOURCE_HASH,
  bytes: ABOUT_BYTES,
};

/**
 * The SAME page after `shared/palette.ts` was edited: identical slug, identical entry bytes,
 * identical `sourceHash`, identical settings — only the closure moved.
 */
const ABOUT_AFTER_SHARED_EDIT: ExportPageSnapshotV1 = {
  ...ABOUT,
  closureHash: ABOUT_CLOSURE_HASH_AFTER_SHARED_EDIT,
};

/**
 * The canonical tree these snapshots were captured from. Small and fixed: nothing in this
 * file asserts on the tree itself, but a snapshot without one would describe a design whose
 * pages import files that do not exist.
 */
const TREE: readonly ExportTreeFileV1[] = [
  { relPath: "pages.json", bytes: new TextEncoder().encode('{"schemaVersion":1,"pages":[]}') },
];

const SNAPSHOT: ExportSnapshotV1 = {
  pages: [HOME, ABOUT],
  tree: TREE,
  capturedAt: "2024-01-01T00:00:00.000Z",
};
const RENDERER_VERSION = "1";

/** `buildExportRenderKey` narrowed for the tests that need a REAL key to seed/probe the cache. */
function requireKey(page: ExportPageSnapshotV1, size: { w: number; h: number }) {
  const key = buildExportRenderKey(page, size, RENDERER_VERSION);
  if (key === null) throw new Error(`expected a render key for "${page.pageSlug}"`);
  return key;
}

describe("buildExportRenderKey", () => {
  test("uses width/height field names and folds in closureHash/kitApiVersion/theme/rendererVersion", () => {
    const key = buildExportRenderKey(HOME, { w: 120, h: 40 }, RENDERER_VERSION);
    expect(key).toEqual({
      closureHash: HOME_CLOSURE_HASH,
      kitApiVersion: HOME.kitApiVersion,
      rendererVersion: RENDERER_VERSION,
      size: { width: 120, height: 40 },
      theme: HOME.theme,
      flags: {},
    });
  });

  test("a shared module's edit changes the key even though the entry's own sourceHash is identical", () => {
    // The whole point of the Task 8 re-key: a rendered frame depends on EVERY module the page
    // imports, so an edit to a shared module the entry file does not itself contain must move
    // the render key. Under the old `sourceHash` key these two were the identical key.
    expect(ABOUT_AFTER_SHARED_EDIT.sourceHash).toBe(ABOUT.sourceHash);
    expect(ABOUT_AFTER_SHARED_EDIT.entryRelPath).toBe(ABOUT.entryRelPath);

    const before = buildExportRenderKey(ABOUT, { w: 200, h: 50 }, RENDERER_VERSION);
    const after = buildExportRenderKey(
      ABOUT_AFTER_SHARED_EDIT,
      { w: 200, h: 50 },
      RENDERER_VERSION,
    );

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after).not.toEqual(before);
  });

  test("a page whose closure could not be proved has NO key at all — `null`, never a fabricated one", () => {
    // `null` is "cannot compute", never "unchanged": encoding it into a key (a literal
    // `"null"` string, or falling back to `sourceHash`) would collide two different pages',
    // or two different points in time's, unprovable closures onto the same cache slot.
    expect(
      buildExportRenderKey({ ...ABOUT, closureHash: null }, { w: 200, h: 50 }, RENDERER_VERSION),
    ).toBeNull();
  });
});

describe("runExportRendering", () => {
  test("dispatches one render task per (page, ladder size), ordered by (manifestIndex, w, h)", async () => {
    const renderCache = createFakeRenderCache();
    const renderPort = createFakeExportRenderPort();

    const results = await runExportRendering(
      { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
      SNAPSHOT,
    );

    // HOME's ladder: 80x24, 120x40, 160x40 (3 sizes); ABOUT's ladder: 200x50 only (1 size).
    expect(results.map((r) => [r.manifestIndex, String(r.pageSlug), r.size.w, r.size.h])).toEqual([
      [0, "home", 80, 24],
      [0, "home", 120, 40],
      [0, "home", 160, 40],
      [1, "about", 200, 50],
    ]);
    expect(renderPort.calls).toHaveLength(4);

    // Assert what the PORT received, not only how many times it was called. §12.5 requires
    // the snapshot's "source bytes/hashes, and resolved settings" to reach the renderer;
    // with only a count asserted, a task carrying the wrong size or theme still passes, and
    // package.ts names the output file from the LADDER size — so the shipped
    // snapshots/home/80x24.txt would contain a render at some other size entirely.
    expect(
      renderPort.calls.map((c) => [c.task.sourceHash, c.task.theme, c.task.size.w, c.task.size.h]),
    ).toEqual([
      [HOME.sourceHash, HOME.theme, 80, 24],
      [HOME.sourceHash, HOME.theme, 120, 40],
      [HOME.sourceHash, HOME.theme, 160, 40],
      [ABOUT.sourceHash, ABOUT.theme, 200, 50],
    ]);
  });

  test("a cache hit is returned without calling renderOne, and is marked cacheHit", async () => {
    // ABOUT's minSize (200x50) is outside the standard ladder, so it renders at exactly
    // one size — pre-populating that one key means every possible renderOne call is
    // covered, and `renderPort.calls` staying empty is a real (not accidental) assertion.
    const renderCache = createFakeRenderCache();
    const renderPort = createFakeExportRenderPort();
    const key = requireKey(ABOUT, { w: 200, h: 50 });
    await renderCache.put({
      key,
      styledFrame: new Uint8Array([9]),
      textFrame: new Uint8Array([8]),
      layout: new Uint8Array([7]),
    });

    const results = await runExportRendering(
      { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [ABOUT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );

    expect(results).toHaveLength(1);
    const hit = results[0];
    expect(hit?.cacheHit).toBe(true);
    if (hit === undefined || "code" in hit.outcome)
      throw new Error("expected a successful cached outcome");
    expect(hit.outcome.styledFrame).toEqual(new Uint8Array([9]));
    expect(renderPort.calls).toEqual([]);
  });

  test("a cache miss renders then populates the cache for next time", async () => {
    const renderCache = createFakeRenderCache();
    const renderPort = createFakeExportRenderPort();

    await runExportRendering(
      { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [ABOUT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );

    expect(renderPort.calls).toHaveLength(1);
    const key = requireKey(ABOUT, { w: 200, h: 50 });
    const cached = await renderCache.get(key);
    expect(cached).not.toBeNull();
  });

  test("a render cached before a shared module changed is NOT served afterwards — the second run is a genuine MISS", async () => {
    // THE LIVE BUG THIS TASK FIXES. Both runs render the identical page, at the identical
    // size, from identical entry bytes; only `shared/palette.ts` moved between them. Keyed on
    // the entry's `sourceHash` the second run was a HIT and the export shipped a frame drawn
    // from the OLD shared module — a silently wrong user-visible artifact.
    const renderCache = createFakeRenderCache();

    const firstPort = createFakeExportRenderPort();
    await runExportRendering(
      { renderPort: firstPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [ABOUT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );
    expect(firstPort.calls).toHaveLength(1); // cold cache: a real render, now cached

    const secondPort = createFakeExportRenderPort();
    const results = await runExportRendering(
      { renderPort: secondPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [ABOUT_AFTER_SHARED_EDIT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );

    expect(results[0]?.cacheHit).toBe(false);
    expect(secondPort.calls).toHaveLength(1);

    // ...and the unchanged closure is still a HIT, so the miss above is the shared module's
    // doing rather than a cache that simply never hits.
    const thirdPort = createFakeExportRenderPort();
    const again = await runExportRendering(
      { renderPort: thirdPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [ABOUT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );
    expect(again[0]?.cacheHit).toBe(true);
    expect(thirdPort.calls).toEqual([]);
  });

  test("a page whose closure cannot be proved (closureHash null) skips the render cache entirely — no get, no put — and logs once", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const renderCache = createFakeRenderCache();
      const renderPort = createFakeExportRenderPort();

      const results = await runExportRendering(
        { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
        {
          pages: [{ ...ABOUT, closureHash: null }],
          tree: TREE,
          capturedAt: SNAPSHOT.capturedAt,
        },
      );

      // A FORCED MISS on BOTH sides. A wrong HIT here corrupts the exported artifact, and a
      // `put` would poison the cache with an entry no honest key could ever describe.
      expect(renderCache.calls).toEqual([]);
      expect(renderPort.calls).toHaveLength(1);
      expect(results[0]?.cacheHit).toBe(false);
      // Skipped, not swallowed (errore rule 21) — once per (page, size), not once per await.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a per-task render failure is reported on that task's outcome without blocking the others", async () => {
    const renderCache = createFakeRenderCache();
    const renderPort = createFakeExportRenderPort();
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_RENDER_FAILED",
      retryable: true,
      safeMessage: "renderer crashed",
      details: {},
    };
    renderPort.failNext("renderOne", FAILURE);

    const results = await runExportRendering(
      { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
      { pages: [HOME, ABOUT], tree: TREE, capturedAt: SNAPSHOT.capturedAt },
    );

    expect(results[0]?.outcome).toEqual(FAILURE); // HOME's first (80x24) task, dispatched first
    const aboutResult = results.find((r) => r.pageSlug === "about");
    expect(aboutResult && "code" in aboutResult.outcome).toBe(false);
  });

  test("results are ordered by (manifestIndex, w, h) even when the LATER task settles FIRST", async () => {
    // Two single-ladder-entry pages (minSize outside the standard ladder, so each renders
    // at exactly one size — one task per manifestIndex) with a bespoke ExportRenderPort
    // whose resolution order this test controls directly. manifestIndex 1 resolves before
    // manifestIndex 0, yet the returned array must still list manifestIndex 0 first.
    const pageA: ExportPageSnapshotV1 = {
      ...HOME,
      pageSlug: slug("a-page"),
      manifestIndex: 0,
      minSize: { w: 200, h: 50 },
    };
    const pageB: ExportPageSnapshotV1 = {
      ...HOME,
      pageSlug: slug("b-page"),
      manifestIndex: 1,
      minSize: { w: 210, h: 60 },
    };
    const twoPageSnapshot: ExportSnapshotV1 = {
      pages: [pageA, pageB],
      tree: TREE,
      capturedAt: SNAPSHOT.capturedAt,
    };

    const poolBounds: ExportRenderPoolBoundsV1 = {
      minWorkers: 1,
      maxWorkers: 1,
      readyQueueMultiplier: 1,
    };
    const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
      module: "@termcraft/runtime",
      currentKitApiVersion: 1,
      supportedKitApiVersions: [1],
      publicCapabilityIds: [],
    };
    const resolvers = new Map<number, (result: FailureDtoV1 | ExportRenderResultV1) => void>();
    const controlledPort: ExportRenderPort = {
      poolBounds,
      runtimeDeclaration,
      renderOne(task: ExportRenderTaskV1) {
        return new Promise((resolve) => {
          resolvers.set(task.manifestIndex, resolve);
        });
      },
    };
    const renderCache = createFakeRenderCache();

    const pending = runExportRendering(
      { renderPort: controlledPort, renderCache, rendererVersion: RENDERER_VERSION },
      twoPageSnapshot,
    );

    // Let both dispatches reach `renderOne` (each crosses one `renderCache.get` await first)
    // and register their resolvers before settling anything.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const bResolve = resolvers.get(1);
    const aResolve = resolvers.get(0);
    if (bResolve === undefined || aResolve === undefined)
      throw new Error("expected both tasks to be pending");

    const bResult: ExportRenderResultV1 = {
      manifestIndex: 1,
      styledFrame: new Uint8Array([1]),
      textFrame: new Uint8Array([1]),
      layout: new Uint8Array([1]),
    };
    const aResult: ExportRenderResultV1 = {
      manifestIndex: 0,
      styledFrame: new Uint8Array([0]),
      textFrame: new Uint8Array([0]),
      layout: new Uint8Array([0]),
    };

    bResolve(bResult); // manifestIndex 1 settles FIRST
    aResolve(aResult); // manifestIndex 0 settles SECOND

    const results = await pending;

    expect(results.map((r) => r.manifestIndex)).toEqual([0, 1]);
  });

  test("integration: the permit is acquired and released (snapshot.ts) before the first renderOne call ever fires", async () => {
    // The negative KCC §13.4 requires: "rendering assertions prove NO permit/mutex is
    // held." This combines snapshot.ts's capture with render-jobs.ts's dispatch behind
    // ONE shared ordered log, proving acquire+release both precede the first renderOne.
    const order: string[] = [];
    const capturePromise = context.start(() => {
      const machine = reatomExportStateMachine();
      const projectWrite = createFakeProjectWriteCoordinator();
      const designReader = createFakeDesignStoreForPages({
        pages: [{ pageSlug: slug("home"), bytes: HOME.bytes, sha256: HOME.sourceHash }],
      });
      const clock = manualClock(1_700_000_000_000);
      const tracedProjectWrite = {
        ...projectWrite,
        acquire: async () => {
          order.push("acquire");
          return projectWrite.acquire();
        },
        release: (permit: Parameters<typeof projectWrite.release>[0]) => {
          order.push("release");
          projectWrite.release(permit);
        },
      };
      return captureExportSnapshot(
        { machine, projectWrite: tracedProjectWrite, designReader, clock },
        {
          pages: [
            {
              pageSlug: HOME.pageSlug,
              treeRoot: HOME.treeRoot,
              entryRelPath: HOME.entryRelPath,
              expectedFiles: HOME.expectedFiles,
              manifestIndex: HOME.manifestIndex,
              minSize: HOME.minSize,
              theme: HOME.theme,
              kitApiVersion: HOME.kitApiVersion,
              closureHash: HOME.closureHash,
            },
          ],
        },
      );
    });
    const snapshotResult = await capturePromise;

    expect(snapshotResult.kind).toBe("captured");
    if (snapshotResult.kind !== "captured") return;

    const renderCache = createFakeRenderCache();
    const renderPort = createFakeExportRenderPort({
      render: (task) => {
        order.push(`renderOne:${task.pageSlug}`);
        return {
          manifestIndex: task.manifestIndex,
          styledFrame: new Uint8Array(0),
          textFrame: new Uint8Array(0),
          layout: new Uint8Array(0),
        };
      },
    });

    await runExportRendering(
      { renderPort, renderCache, rendererVersion: RENDERER_VERSION },
      snapshotResult.snapshot,
    );

    const firstRenderIndex = order.findIndex((entry) => entry.startsWith("renderOne:"));
    const acquireIndex = order.indexOf("acquire");
    const releaseIndex = order.indexOf("release");
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(acquireIndex);
    expect(firstRenderIndex).toBeGreaterThan(releaseIndex);
  });
});

import { describe, expect, test } from "bun:test";

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
import { computeSourceHash } from "entities/design-tree";
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

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
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
  sourceHash: ABOUT_SOURCE_HASH,
  bytes: ABOUT_BYTES,
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

describe("buildExportRenderKey", () => {
  test("uses width/height field names and folds in sourceHash/kitApiVersion/theme/rendererVersion", () => {
    const key = buildExportRenderKey(HOME, { w: 120, h: 40 }, RENDERER_VERSION);
    expect(key).toEqual({
      sourceHash: HOME.sourceHash,
      kitApiVersion: HOME.kitApiVersion,
      rendererVersion: RENDERER_VERSION,
      size: { width: 120, height: 40 },
      theme: HOME.theme,
      flags: {},
    });
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
    const key = buildExportRenderKey(ABOUT, { w: 200, h: 50 }, RENDERER_VERSION);
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
    const key = buildExportRenderKey(ABOUT, { w: 200, h: 50 }, RENDERER_VERSION);
    const cached = await renderCache.get(key);
    expect(cached).not.toBeNull();
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

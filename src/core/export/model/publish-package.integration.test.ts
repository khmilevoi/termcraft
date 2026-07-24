import { afterEach, describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";
import { createExportPublishAdapter } from "store/adapters/export-publish";
import { createProjectWriteAdapter } from "store/adapters/project-write";
import { cleanupScratchRoots, createRealProjectFixture } from "store/adapters/test-support";

import type { ExportPageSnapshotV1, ExportSnapshotV1 } from "../types";
import { assembleExportPackage } from "./package";
import { buildExportPublishOperations } from "./publish-plan";
import type { ExportRenderJobResultV1 } from "./render-jobs";

/**
 * WP-5 closeout acceptance (Phase B, B1-B3 combined): exports a fixture project's ASSEMBLED
 * package to a REAL temp project directory (through the store's real `ExportPublishPort`
 * adapter, not a fake) and asserts every page's `layout/<slug>.json` on disk is non-empty
 * and carries a real tree at every rendered ladder size — the exact acceptance the closeout
 * plan names verbatim. This is `core/export`'s own module (B1's `assembleExportPackage` and
 * B2's `buildExportPublishOperations` are pure and disk-free) proven against `store`'s real
 * adapter (B3's `publishExport` wiring) rather than a fake, without needing Phase D's CLI —
 * a genuine, disk-real, end-to-end proof of the whole in-memory-to-durable path this phase
 * closes.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

function layoutBytes(box: { w: number; h: number }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: box.w, height: box.h },
      children: [],
    }),
  );
}

const SIZES = [
  { w: 80, h: 24 },
  { w: 120, h: 40 },
];

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "a".repeat(64),
  bytes: new TextEncoder().encode("export default function Home() {}\n"),
};

const ABOUT: ExportPageSnapshotV1 = {
  pageSlug: slug("about"),
  sourcePath: "pages/about/page.tsx",
  manifestIndex: 1,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "b".repeat(64),
  bytes: new TextEncoder().encode("export default function About() {}\n"),
};

function rendersFor(page: ExportPageSnapshotV1): ExportRenderJobResultV1[] {
  return SIZES.map((size) => ({
    manifestIndex: page.manifestIndex,
    pageSlug: page.pageSlug,
    size,
    outcome: {
      manifestIndex: page.manifestIndex,
      styledFrame: new Uint8Array([1]),
      textFrame: new TextEncoder().encode(`${page.pageSlug} @ ${size.w}x${size.h}`),
      layout: layoutBytes(size),
    },
    cacheHit: false,
  }));
}

afterEach(cleanupScratchRoots);

describe("WP-5 closeout acceptance: export -> real disk", () => {
  test("every page's layout/<slug>.json on disk parses to a size-keyed object with a non-empty tree at every rendered size", async () => {
    const snapshot: ExportSnapshotV1 = {
      pages: [HOME, ABOUT],
      capturedAt: "2026-07-24T00:00:00.000Z",
    };
    const renders = [...rendersFor(HOME), ...rendersFor(ABOUT)];

    const assembled = assembleExportPackage({
      snapshot,
      renders,
      runtimeDeclaration: {
        module: "@termcraft/runtime",
        currentKitApiVersion: 1,
        supportedKitApiVersions: [1],
        publicCapabilityIds: [],
      },
    });
    if (assembled.kind !== "assembled") throw new Error("fixture bug: expected assembled");

    const generationId = uuidv7();
    const { operations, payloads } = buildExportPublishOperations({
      files: assembled.files,
      generationId,
      previousPointer: null,
    });

    const { open, deps } = await createRealProjectFixture();
    try {
      const writeCoordinator = createProjectWriteAdapter({ mutex: open.writeMutex });
      const adapter = createExportPublishAdapter(deps);

      const permit = await writeCoordinator.acquire();
      const published = await adapter.publish({
        generationId,
        pageCount: snapshot.pages.length,
        createdAt: "2026-07-24T00:00:00.000Z",
        operations,
        payloads,
      });
      writeCoordinator.release(permit);
      if ("code" in published) {
        throw new Error(`fixture bug: publish() failed: ${published.safeMessage}`);
      }

      for (const page of snapshot.pages) {
        const target = `export/generations/${generationId}/layout/${page.pageSlug}.json`;
        const bytes = open.safeFs.readFile(target);
        if (bytes instanceof Error) {
          throw new Error(`fixture bug: could not read "${target}": ${bytes.message}`);
        }
        expect(bytes.byteLength).toBeGreaterThan(0);

        const tree = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        for (const size of SIZES) {
          const key = `${size.w}x${size.h}`;
          expect(tree[key]).toBeDefined();
          expect(tree[key]).not.toEqual({});
        }
      }

      // Ties B1-B3 together with the already-landed Phase C read side: the durable pointer
      // genuinely references every written generation file, including both pages' layouts.
      const pointer = await adapter.readPointer();
      if (pointer === null || "code" in pointer) throw new Error("fixture bug: expected a pointer");
      expect(pointer.generationId).toBe(generationId);
      for (const page of snapshot.pages) {
        const target = `export/generations/${generationId}/layout/${page.pageSlug}.json`;
        expect(pointer.files[target]).toBeDefined();
      }
    } finally {
      await open.close();
    }
  });
});

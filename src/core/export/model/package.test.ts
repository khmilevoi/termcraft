import { describe, expect, test } from "bun:test";

import type { RuntimeDeclarationBundleV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { ExportPageSnapshotV1, ExportSnapshotV1 } from "../types";
import { assembleExportPackage } from "./package";
import type { ExportRenderJobResultV1 } from "./render-jobs";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const HOME_BYTES = new TextEncoder().encode(
  "export const meta = {} \n export default function Home() {}\n",
);

const HOME: ExportPageSnapshotV1 = {
  pageSlug: slug("home"),
  sourcePath: "pages/home/page.tsx",
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "a".repeat(64),
  bytes: HOME_BYTES,
};

const SNAPSHOT: ExportSnapshotV1 = { pages: [HOME], capturedAt: "2024-01-01T00:00:00.000Z" };

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["cap.a"],
};

function renderResult(overrides: Partial<ExportRenderJobResultV1> = {}): ExportRenderJobResultV1 {
  return {
    manifestIndex: 0,
    pageSlug: slug("home"),
    size: { w: 80, h: 24 },
    outcome: {
      manifestIndex: 0,
      styledFrame: new Uint8Array([1]),
      textFrame: new TextEncoder().encode("HOME @ 80x24"),
      layout: new Uint8Array([9]),
    },
    cacheHit: false,
    ...overrides,
  };
}

function fileMap(
  files: readonly { readonly relPath: string; readonly bytes: Uint8Array }[],
): Map<string, Uint8Array> {
  return new Map(files.map((f) => [f.relPath, f.bytes]));
}

describe("assembleExportPackage", () => {
  test("assembles design-prompt.md, runtime-api.json, one page copy, one layout stub, and one snapshot per render", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });

    expect(result.kind).toBe("assembled");
    if (result.kind !== "assembled") return;

    const paths = result.files.map((f) => f.relPath).sort();
    expect(paths).toEqual([
      "design-prompt.md",
      "layout/home.json",
      "pages/home/page.tsx",
      "runtime-api.json",
      "snapshots/home/80x24.txt",
    ]);
  });

  test("pages/<slug>/page.tsx carries the EXACT canonical source bytes, byte for byte", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    expect(files.get("pages/home/page.tsx")).toEqual(HOME_BYTES);
  });

  test("snapshots/<slug>/<w>x<h>.txt carries the render's textFrame bytes", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    expect(files.get("snapshots/home/80x24.txt")).toEqual(new TextEncoder().encode("HOME @ 80x24"));
  });

  test("layout/<slug>.json ships UNPOPULATED ({}) — never the render's own layout bytes", () => {
    // KCC known-divergence: the conformant correlated capture awaits the 2A bulk schema.
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    const layoutBytes = files.get("layout/home.json");
    expect(layoutBytes).toBeDefined();
    expect(new TextDecoder().decode(layoutBytes)).toBe("{}");
  });

  test("runtime-api.json round-trips the exact RuntimeDeclarationBundleV1", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    const json = JSON.parse(new TextDecoder().decode(files.get("runtime-api.json")));
    expect(json).toEqual(RUNTIME_DECLARATION);
  });

  test("design-prompt.md names every page, its theme/kitApiVersion, and every rendered size", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    const prompt = new TextDecoder().decode(files.get("design-prompt.md"));
    expect(prompt).toContain("home");
    expect(prompt).toContain("default");
    expect(prompt).toContain("kitApiVersion: 1");
    expect(prompt).toContain("80x24");
    expect(prompt).toContain("snapshots/home/80x24.txt");
  });

  test("a failed render is refused wholesale — no package is assembled with a missing size", () => {
    const FAILURE: FailureDtoV1 = {
      code: "EXPORT_RENDER_FAILED",
      retryable: true,
      safeMessage: "renderer crashed",
      details: {},
    };
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult({ outcome: FAILURE })],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });

    expect(result).toEqual({ kind: "failed", failure: FAILURE });
  });

  test("two sizes for the same page produce two distinct snapshot files, not one overwritten", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [
        renderResult(),
        renderResult({
          size: { w: 120, h: 40 },
          outcome: {
            manifestIndex: 0,
            styledFrame: new Uint8Array(),
            textFrame: new TextEncoder().encode("HOME @ 120x40"),
            layout: new Uint8Array(),
          },
        }),
      ],
      runtimeDeclaration: RUNTIME_DECLARATION,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const paths = result.files.map((f) => f.relPath);
    expect(paths).toContain("snapshots/home/80x24.txt");
    expect(paths).toContain("snapshots/home/120x40.txt");
  });
});

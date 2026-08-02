import { describe, expect, test } from "bun:test";

import type { RuntimeDeclarationBundleV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type {
  ExportClosureV1,
  ExportPageSnapshotV1,
  ExportSnapshotV1,
  ExportTreeFileV1,
} from "../types";
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
  treeRoot: "/proj/.termcraft/design",
  entryRelPath: "pages/home.tsx",
  expectedFiles: [{ relPath: "pages/home.tsx", sha256: "0".repeat(64) }],
  manifestIndex: 0,
  minSize: { w: 80, h: 24 },
  theme: "default",
  kitApiVersion: 1,
  sourceHash: "a".repeat(64),
  bytes: HOME_BYTES,
};

const THEME_BYTES = new TextEncoder().encode('export const theme = "one"\n');
const MANIFEST_BYTES = new TextEncoder().encode(
  '{"schemaVersion":1,"pages":[{"slug":"home","entry":"pages/home.tsx"}]}',
);

/** A tree with a SHARED module the entry imports — the case one file per page could not describe. */
const TREE: readonly ExportTreeFileV1[] = [
  { relPath: "pages.json", bytes: MANIFEST_BYTES },
  { relPath: "pages/home.tsx", bytes: HOME_BYTES },
  { relPath: "lib/theme.ts", bytes: THEME_BYTES },
];

const CLOSURES: readonly ExportClosureV1[] = [
  { pageSlug: slug("home"), entry: "pages/home.tsx", files: ["lib/theme.ts", "pages/home.tsx"] },
];

const SNAPSHOT: ExportSnapshotV1 = {
  pages: [HOME],
  tree: TREE,
  capturedAt: "2024-01-01T00:00:00.000Z",
};

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["cap.a"],
};

function layoutTreeBytes(box: { w: number; h: number }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: box.w, height: box.h },
      children: [],
    }),
  );
}

function renderResult(overrides: Partial<ExportRenderJobResultV1> = {}): ExportRenderJobResultV1 {
  return {
    manifestIndex: 0,
    pageSlug: slug("home"),
    size: { w: 80, h: 24 },
    outcome: {
      manifestIndex: 0,
      styledFrame: new Uint8Array([1]),
      textFrame: new TextEncoder().encode("HOME @ 80x24"),
      layout: layoutTreeBytes({ w: 80, h: 24 }),
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
  test("assembles design-prompt.md, runtime-api.json, one page copy, one layout file, and one snapshot per render", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });

    expect(result.kind).toBe("assembled");
    if (result.kind !== "assembled") return;

    const paths = result.files.map((f) => f.relPath).sort();
    expect(paths).toEqual([
      "closures/home.json",
      "design-prompt.md",
      "design/lib/theme.ts",
      "design/pages.json",
      "design/pages/home.tsx",
      "layout/home.json",
      "runtime-api.json",
      "snapshots/home/80x24.txt",
    ]);
    // The retired shape, pinned so it cannot creep back: a slug-derived per-page copy is
    // exactly what the design tree replaced (design §11, task 16).
    expect(paths.some((path) => path.startsWith("pages/"))).toBe(false);
  });

  test("design/<treeRelPath> carries the EXACT canonical bytes of EVERY tree file, byte for byte", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    expect(files.get("design/pages/home.tsx")).toEqual(HOME_BYTES);
    // The shared module ships too — it is what the entry imports, and no per-page copy of the
    // entry alone could have carried it.
    expect(files.get("design/lib/theme.ts")).toEqual(THEME_BYTES);
    expect(files.get("design/pages.json")).toEqual(MANIFEST_BYTES);
  });

  test("closures/<slug>.json lists the page's whole closure, package-relative", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const bytes = fileMap(result.files).get("closures/home.json");
    if (bytes === undefined) throw new Error("expected a closure listing for home");
    const closure = JSON.parse(new TextDecoder().decode(bytes)) as {
      pageSlug: string;
      entry: string;
      files: string[];
    };
    expect(closure.pageSlug).toBe("home");
    expect(closure.entry).toBe("design/pages/home.tsx");
    // Prefixed the same way the tree files are, so a reader of the package never has to know
    // the tree-relative convention exists.
    expect(closure.files).toEqual(["design/lib/theme.ts", "design/pages/home.tsx"]);
  });

  test("a page whose closure could not be resolved ships NO listing, and design-prompt.md says so", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: [],
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    expect(result.files.some((file) => file.relPath.startsWith("closures/"))).toBe(false);
    const prompt = new TextDecoder().decode(fileMap(result.files).get("design-prompt.md"));
    // An honest absence, stated where the reader looks — never a listing naming the entry
    // alone, which would claim the page needs nothing else.
    expect(prompt).toContain("closure: unavailable");
  });

  test("snapshots/<slug>/<w>x<h>.txt carries the render's textFrame bytes", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    expect(files.get("snapshots/home/80x24.txt")).toEqual(new TextEncoder().encode("HOME @ 80x24"));
  });

  test("layout/<slug>.json is a size-keyed object carrying every rendered size's real tree (D-Q1)", () => {
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
            layout: layoutTreeBytes({ w: 120, h: 40 }),
          },
        }),
      ],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    const layoutBytes = files.get("layout/home.json");
    expect(layoutBytes).toBeDefined();
    expect(layoutBytes?.byteLength).toBeGreaterThan(0);

    const parsed = JSON.parse(new TextDecoder().decode(layoutBytes)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["120x40", "80x24"]);
    expect(parsed["80x24"]).toEqual({
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: 80, height: 24 },
      children: [],
    });
    expect(parsed["120x40"]).toEqual({
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: 120, height: 40 },
      children: [],
    });
  });

  test("layout/<slug>.json is byte-identical across two fresh assemblies of the same inputs (determinism)", () => {
    const build = () =>
      assembleExportPackage({
        snapshot: SNAPSHOT,
        renders: [renderResult()],
        runtimeDeclaration: RUNTIME_DECLARATION,
        closures: CLOSURES,
      });
    const first = build();
    const second = build();
    if (first.kind !== "assembled" || second.kind !== "assembled") {
      throw new Error("expected assembled");
    }

    expect(fileMap(first.files).get("layout/home.json")).toEqual(
      fileMap(second.files).get("layout/home.json"),
    );
  });

  test("a page with zero rendered sizes gets the honest {} stub, never a fabricated tree", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const files = fileMap(result.files);
    expect(new TextDecoder().decode(files.get("layout/home.json"))).toBe("{}");
  });

  test("a render whose layout bytes are not valid JSON is refused wholesale, not silently dropped", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [
        renderResult({
          outcome: {
            manifestIndex: 0,
            styledFrame: new Uint8Array(),
            textFrame: new Uint8Array(),
            layout: new TextEncoder().encode("not json{"),
          },
        }),
      ],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.code).toBe("EXPORT_RENDER_FAILED");
  });

  test("runtime-api.json round-trips the exact RuntimeDeclarationBundleV1", () => {
    const result = assembleExportPackage({
      snapshot: SNAPSHOT,
      renders: [renderResult()],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
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
      closures: CLOSURES,
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
      closures: CLOSURES,
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
            layout: layoutTreeBytes({ w: 120, h: 40 }),
          },
        }),
      ],
      runtimeDeclaration: RUNTIME_DECLARATION,
      closures: CLOSURES,
    });
    if (result.kind !== "assembled") throw new Error("expected assembled");

    const paths = result.files.map((f) => f.relPath);
    expect(paths).toContain("snapshots/home/80x24.txt");
    expect(paths).toContain("snapshots/home/120x40.txt");
  });
});

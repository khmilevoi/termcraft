import { describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { GateRunResultV1 } from "../gate-runner";
import { createFakeGateRunner } from "./gate-runner";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

describe("createFakeGateRunner", () => {
  test("runPage() defaults to a clean pass with a synthesized descriptor", async () => {
    const runner = createFakeGateRunner();
    const result = await runner.runPage({
      source: "export const meta = {}",
      slug: slug("home"),
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/home.tsx",
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.descriptor?.slug).toBe(slug("home"));
  });

  test("runManifestSlice() defaults to an honest empty slice with no errors", async () => {
    const runner = createFakeGateRunner();
    const result = await runner.runManifestSlice({
      manifestText: "{}",
      treePaths: ["pages/home.tsx", "pages/about.tsx"],
    });
    expect(result.errors).toEqual([]);
    // `treePaths` is a flat file-path inventory, not `PageEntryV1[]` — the fake has no honest
    // way to synthesize page identities out of bare paths, so the default is an honest empty,
    // not a fabricated echo. A caller wanting a specific slice scripts it via
    // `queueRunManifestSliceResult`.
    expect(result.slice).toEqual({ pages: [], active: null });
  });

  test("runTreeImports() defaults to no errors and no closures, and records the file/tree-path/page counts", async () => {
    const runner = createFakeGateRunner();
    const result = await runner.runTreeImports({
      files: new Map([["pages/home.tsx", "export const x = 1\n"]]),
      treePaths: ["pages/home.tsx", "lib/theme.ts"],
      pages: [{ slug: slug("home"), entry: "pages/home.tsx" }],
    });
    expect(result).toEqual({ errors: [], closures: [] });
    expect(runner.calls).toEqual([
      { method: "runTreeImports", fileCount: 1, treePathCount: 2, pageCount: 1 },
    ]);
  });

  test("queueRunTreeImportsResult() scripts the next runTreeImports() outcome, one shot", async () => {
    const runner = createFakeGateRunner();
    const scripted = {
      errors: [{ kind: "import" as const, code: "FORBIDDEN_IMPORT", message: "no" }],
      closures: [{ slug: slug("home"), files: ["pages/home.tsx"] }],
    };
    runner.queueRunTreeImportsResult(scripted);
    const first = await runner.runTreeImports({ files: new Map(), treePaths: [], pages: [] });
    expect(first).toEqual(scripted);
    const second = await runner.runTreeImports({ files: new Map(), treePaths: [], pages: [] });
    expect(second).toEqual({ errors: [], closures: [] });
  });

  test("queueRunPageResult() scripts the next runPage() outcome, one shot", async () => {
    const runner = createFakeGateRunner();
    const scripted: GateRunResultV1 = {
      ok: false,
      errors: [{ kind: "type", code: "TS2322", message: "type mismatch" }],
      warnings: [],
      descriptor: null,
    };
    runner.queueRunPageResult(scripted);
    const first = await runner.runPage({
      source: "bad",
      slug: slug("home"),
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/home.tsx",
    });
    expect(first).toEqual(scripted);
    const second = await runner.runPage({
      source: "ok",
      slug: slug("home"),
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/home.tsx",
    });
    expect(second.ok).toBe(true);
  });

  test("records calls with their inputs in order", async () => {
    const runner = createFakeGateRunner();
    await runner.runManifestSlice({ manifestText: "{}", treePaths: ["pages/home.tsx"] });
    await runner.runPage({
      source: "x",
      slug: slug("home"),
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/home.tsx",
    });
    expect(runner.calls.map((c) => c.method)).toEqual(["runManifestSlice", "runPage"]);
  });
});

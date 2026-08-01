import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeGateRunner } from "core/ports/fakes";
import type { PageSlug } from "entities/page";

import type { SmokeRenderer, SmokeRequest, SmokeResult } from "../ports/smoke-renderer";
import { createGateRunnerAdapter } from "./gate-runner";

const SLUG = "dash" as PageSlug;

const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

/** A trivial, offline-runnable fake SmokeRenderer — a fixed scripted result, no host process. */
function fakeSmokeRenderer(result: SmokeResult): SmokeRenderer {
  return { render: async (_request: SmokeRequest) => result };
}

/**
 * Mimics the REAL host `SmokeRenderer` (`host/adapters/smoke-renderer.ts` -> `host/session
 * /model/source-mount.ts`'s `loadPage`): resolves `request.sourcePath` on disk via `Bun.file`,
 * exactly as the real host child process does, instead of returning a scripted result. Used
 * to prove this adapter's `sourcePath` wiring for real — a fixed `{ok:true}` fake (like every
 * other test in this file) would never notice a bare, unresolvable `${slug}.tsx` default.
 */
function realDiskSmokeRenderer(): SmokeRenderer {
  return {
    render: async (request: SmokeRequest) => {
      const bytes = await Bun.file(request.sourcePath)
        .bytes()
        .catch(() => null);
      if (bytes === null) {
        return {
          ok: false,
          code: "SMOKE_SOURCE_UNREADABLE",
          message: `cannot read ${request.sourcePath}`,
        };
      }
      return { ok: true };
    },
  };
}

describe("createGateRunnerAdapter", () => {
  test("runPage() passes a clean candidate with a clean smoke render, carrying the descriptor", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.descriptor).toEqual({
      slug: SLUG,
      meta: {
        kitApiVersion: 1,
        title: "Dashboard",
        minSize: { w: 80, h: 24 },
        theme: "dark-default",
      },
    });
  });

  test("KNOWN SECURITY GAP, NOT CORRECT BEHAVIOR (task-12 review round 1, registered in red-debt.md as must-wire): runPage() no longer scans imports itself, and nothing else in the shipped pipeline calls runTreeImports() yet, so a forbidden import currently reaches the smoke render", async () => {
    // This test does NOT assert desired behavior — it pins TODAY's actual gap: `runPage` itself
    // never scans imports (task 12's own design moved that to `runTreeImports`, run once per
    // turn over the whole tree). `smokeRan === true` here is the bug, not the feature.
    //
    // CORRECTED (task-12 review round 1, finding 1b — the prior wording over-claimed): this
    // test drives `adapter.runPage(...)` directly, so it will KEEP PASSING even after Task 14
    // wires `runTreeImports` into `core/turns/model/validation.ts` — that wiring changes what
    // the TURN does around `runPage`, not what `runPage` itself does. It only fails if
    // `runPage`/`runGate` starts scanning imports again, a regression of THIS task's own
    // design — it is NOT a safety net for the wiring ever happening. Task 14 owns proving the
    // wiring itself works, with its own test in `core/turns/model/validation.test.ts` asserting
    // that a forbidden import in a shared module fails the TURN, not merely that
    // `scanTreeImports`/`runTreeImports` can detect it in isolation (see red-debt.md's
    // SECURITY-CRITICAL entry). See `gate/model/gate.ts`'s `runTreeImports` doc and `core/
    // ports/gate-runner.ts`'s `GateRunner.runTreeImports` doc for the full flag.
    let smokeRan = false;
    const adapter = createGateRunnerAdapter({
      smokeRenderer: {
        render: async () => {
          smokeRan = true;
          return { ok: true };
        },
      },
    });
    const result = await adapter.runPage({
      source: `import { x } from "lodash"\n${cleanSource}`,
      slug: SLUG,
    });
    expect(result.errors.some((e) => e.kind === "import")).toBe(false);
    expect(smokeRan).toBe(true);
  });

  test("runTreeImports() catches the SAME forbidden import once per turn, over the whole tree", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const badSource = `import { x } from "lodash"\n${cleanSource}`;
    const errors = await adapter.runTreeImports({
      files: new Map([["dash.tsx", badSource]]),
      treePaths: ["dash.tsx"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("import");
    expect(errors[0]?.file).toBe("dash.tsx");
  });

  test("runPage() surfaces a failed smoke render as a smoke-kind error", async () => {
    const adapter = createGateRunnerAdapter({
      smokeRenderer: fakeSmokeRenderer({
        ok: false,
        code: "DESIGN_RENDER_FAILED",
        message: "boom",
      }),
    });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "smoke" && e.code === "DESIGN_RENDER_FAILED")).toBe(
      true,
    );
  });

  test("runPage() without compilerAssets/runtimeDts skips the type-check stage (an honest omission, not a fabricated pass)", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.errors.some((e) => e.kind === "type")).toBe(false);
  });

  test("runPage() forwards an injected checkManifest port", async () => {
    let checkManifestCalled = false;
    const adapter = createGateRunnerAdapter({
      smokeRenderer: fakeSmokeRenderer({ ok: true }),
      checkManifest: () => {
        checkManifestCalled = true;
        return [];
      },
    });
    await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(checkManifestCalled).toBe(true);
  });

  test("runManifestSlice() validates a clean manifest slice — entry resolves against treePaths (design §4)", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "dash", entry: "dash.tsx" }],
      }),
      treePaths: ["dash.tsx"],
    });
    expect(result.errors).toEqual([]);
    expect(result.slice).toEqual({ pages: [{ slug: SLUG, entry: "dash.tsx" }], active: null });
  });

  test("runManifestSlice() rejects an entry that does not resolve to a file in the tree", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runManifestSlice({
      manifestText: JSON.stringify({
        schemaVersion: 1,
        pages: [{ slug: "missing-page", entry: "missing.tsx" }],
      }),
      treePaths: ["dash.tsx"],
    });
    expect(result.slice).toBeNull();
    expect(result.errors.some((e) => e.code === "MANIFEST_ENTRY_UNRESOLVED")).toBe(true);
  });

  test("runPage() threads sourcePath into the smoke stage so a REAL disk-resolving renderer finds the staged candidate file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-smoke-"));
    const stagedPath = path.join(dir, "dash.tsx");
    fs.writeFileSync(stagedPath, cleanSource);
    try {
      const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
      const result = await adapter.runPage({
        source: cleanSource,
        slug: SLUG,
        sourcePath: stagedPath,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runPage() without sourcePath falls back to a bare `${slug}.tsx`, which a REAL disk-resolving renderer cannot find", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
    const result = await adapter.runPage({ source: cleanSource, slug: SLUG });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.kind === "smoke" && e.code === "SMOKE_SOURCE_UNREADABLE"),
    ).toBe(true);
  });

  test("runPage() prefers entryRelPath over the slug-derived default for a contract error's `file`, even when entry is unrelated to slug", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const brokenContract = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await adapter.runPage({
      source: brokenContract,
      slug: SLUG,
      entryRelPath: "screens/overview/index.tsx",
      closure: { entry: "screens/overview/index.tsx", files: ["screens/overview/index.tsx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  test("runPage() has entryRelPath out-rank fileName when both are supplied (task-12 review round 1, Important 4) — a separate copy of runGate's own precedence, mirrored here because this adapter also uses fileName for smokeSourcePath", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const brokenContract = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await adapter.runPage({
      source: brokenContract,
      slug: SLUG,
      fileName: "stale/slug-guess.tsx",
      entryRelPath: "screens/overview/index.tsx",
      closure: { entry: "screens/overview/index.tsx", files: ["screens/overview/index.tsx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  test("contract: an all-clear candidate matches the fake oracle's own default GateRunResultV1 shape", async () => {
    const fake = createFakeGateRunner();
    const real = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const input = { source: cleanSource, slug: SLUG };
    const fakeResult = await fake.runPage(input);
    const realResult = await real.runPage(input);
    expect(realResult.ok).toBe(fakeResult.ok);
    expect(realResult.descriptor?.slug).toBe(fakeResult.descriptor?.slug);
  });
});

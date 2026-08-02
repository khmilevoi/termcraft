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
    const result = await adapter.runTreeImports({
      files: new Map([["dash.tsx", badSource]]),
      treePaths: ["dash.tsx"],
      pages: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("import");
    expect(result.errors[0]?.file).toBe("dash.tsx");
  });

  describe("runTreeImports() closures (task-13 review round 1, Critical C1)", () => {
    test("a page's closure reaches a module TRANSITIVELY, not just its own entry's direct imports", async () => {
      // pages/a.tsx -> lib/theme.ts -> lib/tokens.ts: a shallow (entry-only, or one-hop) closure
      // would pass this test with `lib/tokens.ts` missing, and would then report "nothing
      // changed" for every consumer when only `lib/tokens.ts` itself edits (design §7's own
      // whole point) — the exact bug this task exists to prevent.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const entrySource = `import { x } from "../lib/theme"\n${cleanSource}`;
      const themeSource = `import { y } from "./tokens"\nexport const x = 1`;
      const tokensSource = `export const y = 2`;
      const files = new Map([
        ["pages/a.tsx", entrySource],
        ["lib/theme.ts", themeSource],
        ["lib/tokens.ts", tokensSource],
      ]);
      const treePaths = ["pages/a.tsx", "lib/theme.ts", "lib/tokens.ts"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [{ slug: "a" as PageSlug, entry: "pages/a.tsx" }],
      });

      expect(result.errors).toEqual([]);
      expect(result.closures).toHaveLength(1);
      const closure = result.closures[0];
      expect(closure?.slug).toBe("a" as PageSlug);
      expect([...(closure?.files ?? [])].sort()).toEqual([
        "lib/theme.ts",
        "lib/tokens.ts",
        "pages/a.tsx",
      ]);
    });

    test("two distinct slugs sharing one module each get the shared file in their own closure", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const themeSource = `export const x = 1`;
      const files = new Map([
        ["pages/a.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["pages/b.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["lib/theme.ts", themeSource],
      ]);
      const treePaths = ["pages/a.tsx", "pages/b.tsx", "lib/theme.ts"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [
          { slug: "a" as PageSlug, entry: "pages/a.tsx" },
          { slug: "b" as PageSlug, entry: "pages/b.tsx" },
        ],
      });

      expect(result.errors).toEqual([]);
      const bySlug = new Map(result.closures.map((c) => [c.slug, [...c.files].sort()]));
      expect(bySlug.get("a" as PageSlug)).toEqual(["lib/theme.ts", "pages/a.tsx"]);
      expect(bySlug.get("b" as PageSlug)).toEqual(["lib/theme.ts", "pages/b.tsx"]);
    });

    test("an unresolvable edge inside the closure is reported ONCE (by the flat scan, not doubled by the closure walk) and the slug's closure is absent, not partial", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/a.tsx", `import { x } from "../lib/missing"\n${cleanSource}`],
      ]);
      const treePaths = ["pages/a.tsx"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [{ slug: "a" as PageSlug, entry: "pages/a.tsx" }],
      });

      expect(result.closures).toEqual([]);
      // Exactly one — the flat scan's own report of the same edge. Task-13 review round 1
      // pushed a SECOND, closure-walk-owned error here too; round 2, Important 2 removed it as
      // pure duplication (this file's own `describe` below pins the multi-page shape that
      // measured the duplication directly).
      expect(result.errors.filter((e) => e.kind === "import")).toHaveLength(1);
    });
  });

  describe("runTreeImports() closure-completeness diagnostics (task-13 review round 2, Important 1)", () => {
    test("BEFORE/AFTER PROOF: an entry whose own source is missing from `files` used to silently truncate to a single-file closure with ZERO diagnostics — now excluded from `closures` with an explicit error", async () => {
      // The exact probe the review executed against `eeaf80f`: `treePaths` names the entry,
      // but `files` never got its text (a caller bug, or a caching gap) — `lib/theme.ts`/
      // `lib/tokens.ts` ARE present, `pages/a.tsx` itself is NOT. Under `eeaf80f` this returned
      // `{errors: [], closures: [{slug:"a", files:["pages/a.tsx"]}]}` — a page reported as
      // "unchanged" forever the moment `lib/theme.ts` edits, since its own closure never even
      // reached that far. Verified by hand: reverting this file's `edgesOf`/`resolveClosuresFor`
      // to the `eeaf80f` shape reproduces exactly that JSON against this same fixture.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
        ["lib/tokens.ts", `export const y = 2`],
        // Deliberately ABSENT: "pages/a.tsx" — its own text is never given to this pass.
      ]);
      const treePaths = ["pages/a.tsx", "lib/theme.ts", "lib/tokens.ts"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [{ slug: "a" as PageSlug, entry: "pages/a.tsx" }],
      });

      expect(result.closures).toEqual([]);
      expect(result.errors).toEqual([
        {
          kind: "import",
          code: "CLOSURE_SOURCE_MISSING",
          message: expect.stringContaining("pages/a.tsx"),
          file: "pages/a.tsx",
        },
      ]);
    });

    test("a file reachable from a scanned file but missing its own text ALSO excludes the closure, alongside whatever the flat scan separately reports for that edge", async () => {
      // The "milder" shape the review also executed: `pages/a.tsx` (scanned) imports
      // `lib/theme.ts` (scanned), which imports `lib/tokens.ts` — present in the tree, but its
      // text is missing. The flat scan independently reports `UNSCANNED_IMPORT` for THAT edge
      // (attributed to `lib/theme.ts`); this is a DIFFERENT fact (page `a`'s closure integrity)
      // reported under a DIFFERENT code, not a duplicate of it.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/a.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
        // Deliberately ABSENT: "lib/tokens.ts" — reachable, but never given text.
      ]);
      const treePaths = ["pages/a.tsx", "lib/theme.ts", "lib/tokens.ts"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [{ slug: "a" as PageSlug, entry: "pages/a.tsx" }],
      });

      expect(result.closures).toEqual([]);
      const closureError = result.errors.find((e) => e.code === "CLOSURE_SOURCE_MISSING");
      expect(closureError?.file).toBe("lib/tokens.ts");
      expect(result.errors.some((e) => e.code === "UNSCANNED_IMPORT")).toBe(true);
    });
  });

  describe("runTreeImports() no longer duplicates a shared-module violation per reaching page (task-13 review round 2, Important 2)", () => {
    test("BEFORE/AFTER PROOF: three pages sharing one forbidden import in one shared module used to report it 4 times (1 flat-scan + 3 closure-walk copies) — now reports it exactly once", async () => {
      // The exact probe the review executed against `eeaf80f`: pages a/b/c each import
      // `lib/theme.ts`, which imports the forbidden `node:fs`. `eeaf80f` returned 4
      // near-identical `FORBIDDEN_IMPORT` entries, all naming `lib/theme.ts`, three of them
      // prefixed `page "x": ` — verified by hand, reverting this file's `resolveClosuresFor` to
      // the `eeaf80f` shape reproduces exactly 4 against this same fixture.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const themeSource = `import fs from "node:fs"\nexport const x = 1`;
      const files = new Map([
        ["pages/a.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["pages/b.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["pages/c.tsx", `import { x } from "../lib/theme"\n${cleanSource}`],
        ["lib/theme.ts", themeSource],
      ]);
      const treePaths = ["pages/a.tsx", "pages/b.tsx", "pages/c.tsx", "lib/theme.ts"];

      const result = await adapter.runTreeImports({
        files,
        treePaths,
        pages: [
          { slug: "a" as PageSlug, entry: "pages/a.tsx" },
          { slug: "b" as PageSlug, entry: "pages/b.tsx" },
          { slug: "c" as PageSlug, entry: "pages/c.tsx" },
        ],
      });

      const forbidden = result.errors.filter((e) => e.code === "FORBIDDEN_IMPORT");
      expect(forbidden).toHaveLength(1);
      expect(forbidden[0]?.file).toBe("lib/theme.ts");
      // None of the three pages get a fabricated closure — the shared module's own violation
      // makes every one of them fatally unresolvable.
      expect(result.closures).toEqual([]);
    });
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

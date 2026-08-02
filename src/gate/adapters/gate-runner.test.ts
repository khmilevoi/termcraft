import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateErrorV1 } from "core/ports";
import { createFakeGateRunner } from "core/ports/fakes";
import type { PageEntryV1 } from "entities/design-tree";
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
      // Exactly one — the flat scan's own report of the same edge. Round 1 pushed a SECOND,
      // closure-walk-owned copy; round 2 removed it by asserting the closure walk was ALWAYS
      // redundant, which round 3 disproved by execution; it is now suppressed only when the
      // importer was scanned in full, which is the case here (see the harness `describe` below,
      // whose "file the flat scan cannot tokenize" row is the case where it is NOT).
      expect(result.errors.filter((e) => e.kind === "import")).toHaveLength(1);
      // And the page is still attributable — the whole point of not emitting a second copy.
      expect(result.errors[0]?.blockedPages).toEqual(["a" as PageSlug]);
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
          // Task-13 review round 3, Minor: the slug used to survive only inside `message`, so a
          // consumer partitioning diagnostics per page could not attribute this one at all.
          blockedPages: ["a" as PageSlug],
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

  describe("runTreeImports() closure invariant harness (task-13 review round 3)", () => {
    /**
     * THE JOINT INVARIANT THIS TABLE EXISTS TO PIN, and why it is a table rather than more
     * one-off tests. Task 13's fix loop see-sawed for two rounds because two obligations are in
     * tension and each round satisfied one by breaking the other:
     *
     *   COMPLETENESS — a closure that could not be proved complete must never be returned as if
     *   it were; `selectChangedPages` reads a truncated closure as "this page did not change",
     *   which is the exact design §7 bug this task exists to prevent, and it is silent.
     *   ECONOMY — one underlying fact produces exactly one diagnostic. Every diagnostic is
     *   rendered into the agent's retry prompt unbounded (`core/turns/model/prompt.ts:96-100`),
     *   and `gate/model/gate.ts`'s whole-tree scan exists precisely so a shared module's
     *   violation is not reported once per reaching page.
     *
     * Round 1 satisfied completeness and duplicated diagnostics 1+N; round 2 removed the
     * duplication and lost diagnostics that were not duplicates. Neither round's tests could
     * catch the other round's defect because each asserted only its own shape — round 2 measured
     * `FORBIDDEN_IMPORT` going 4 -> 1 while shipping `CLOSURE_SOURCE_MISSING` going 1 -> 4.
     *
     * So every row below asserts BOTH sides EXACTLY: the full diagnostic multiset (code, file
     * and the blocked page slugs — not a `.some(...)`, not a length) AND the full closure list.
     * A change that trades one obligation for the other cannot make this table pass.
     *
     * Each row's `history` records what the two prior shipped revisions actually returned for
     * that same fixture, executed (`git show <rev>:src/gate/adapters/gate-runner.ts`, restored
     * byte-identically afterwards), so a future reader can see which direction each row guards.
     */
    interface ClosureHarnessRowV1 {
      readonly name: string;
      /** Executed output of `dba54e9` / `eeaf80f` for this exact fixture. */
      readonly history: string;
      readonly files: readonly (readonly [string, string])[];
      readonly treePaths: readonly string[];
      readonly pages: readonly PageEntryV1[];
      /** EXACT multiset: `CODE @ file` plus the sorted blocked slugs, itself sorted. */
      readonly errors: readonly string[];
      /** EXACT closures: `slug: [sorted files]`, sorted. */
      readonly closures: readonly string[];
    }

    const entry = (slug: string, path: string): PageEntryV1 => ({
      slug: slug as PageSlug,
      entry: path,
    });
    const META = `export const meta = 1`;
    /** The one measured shape that defeats the flat scan's JSX reader (`tree-scan.ts`'s own
     *  `TreeFileUnscannableError` doc: returns at 24 000 characters, throws at 32 000). */
    const UNSCANNABLE = `import fs from "node:fs"\n${"<a>{".repeat(32000)}`;

    const renderErrors = (errors: readonly GateErrorV1[]): readonly string[] =>
      errors
        .map(
          (error) =>
            `${error.code} @ ${String(error.file)}${
              error.blockedPages === undefined ? "" : ` blocked=[${error.blockedPages.join(",")}]`
            }`,
        )
        .sort();

    const renderClosures = (
      closures: readonly { readonly slug: PageSlug; readonly files: readonly string[] }[],
    ): readonly string[] =>
      closures.map((closure) => `${closure.slug}: [${[...closure.files].sort().join(",")}]`).sort();

    const rows: readonly ClosureHarnessRowV1[] = [
      {
        name: "an entry absent from `files` but present in `treePaths` — the closure truncates to the entry alone",
        history:
          "dba54e9: no diagnostic, no closure (it resolved none at all). eeaf80f: ZERO diagnostics and a FABRICATED one-file closure `a: [pages/a.tsx]` — the silent §7 bug.",
        files: [
          ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
          ["lib/tokens.ts", `export const y = 2`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.ts", "lib/tokens.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["CLOSURE_SOURCE_MISSING @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "an entry absent from `treePaths` — a refusal BEFORE any edge is walked, which the flat scan can never report",
        history:
          "dba54e9: nothing. eeaf80f: 1 UNRESOLVED_IMPORT @ pages/a.tsx. 45e278a: NOTHING — the round-2 deletion lost it (round 3 Critical (a)).",
        files: [["lib/theme.ts", `export const x = 1`]],
        treePaths: ["lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["UNRESOLVED_IMPORT @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "an entry present in `files` but not in `treePaths` — scanned as a file, still not resolvable as an entry",
        history: "Same as the row above on all three revisions; the flat scan reports nothing.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["lib/theme.ts", `export const x = 1`],
        ],
        treePaths: ["lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["UNRESOLVED_IMPORT @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "a reachable module in `treePaths` with no text in `files`, reached by ONE page",
        history:
          "dba54e9: 1 UNSCANNED_IMPORT, no closures. eeaf80f: 1 UNSCANNED_IMPORT and a closure that LOOKS complete but stops wherever `lib/tokens.ts` would have led. 45e278a: 2.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.ts", "lib/tokens.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [
          "CLOSURE_SOURCE_MISSING @ lib/tokens.ts blocked=[a]",
          "UNSCANNED_IMPORT @ lib/theme.ts",
        ],
        closures: [],
      },
      {
        name: "the same missing module reached by THREE pages — the count must not grow with the number of reaching pages",
        history:
          "THIS IS WHERE ROUND 2 REGRESSED: 45e278a returned 4 diagnostics for the ONE missing file (1 UNSCANNED_IMPORT + 3 CLOSURE_SOURCE_MISSING differing only by page). eeaf80f returned 1, plus three truncated closures.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["pages/b.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["pages/c.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "pages/b.tsx", "pages/c.tsx", "lib/theme.ts", "lib/tokens.ts"],
        pages: [entry("a", "pages/a.tsx"), entry("b", "pages/b.tsx"), entry("c", "pages/c.tsx")],
        // Byte-for-byte the row above's diagnostics, only `blocked` widens: one fact, one
        // diagnostic, three attributions.
        errors: [
          "CLOSURE_SOURCE_MISSING @ lib/tokens.ts blocked=[a,b,c]",
          "UNSCANNED_IMPORT @ lib/theme.ts",
        ],
        closures: [],
      },
      {
        name: "a file the flat scan cannot tokenize that ALSO holds a forbidden import — the closure walk is the only reader that sees it",
        history:
          "dba54e9: 1 (UNSCANNABLE_SOURCE only). eeaf80f: 2 — it reported the `node:fs` import too. 45e278a: 1 — the FORBIDDEN_IMPORT VANISHED (round 3 Critical (b)).",
        files: [["pages/a.tsx", UNSCANNABLE]],
        treePaths: ["pages/a.tsx"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [
          "FORBIDDEN_IMPORT @ pages/a.tsx blocked=[a]",
          "UNSCANNABLE_SOURCE @ pages/a.tsx blocked=[a]",
        ],
        closures: [],
      },
      {
        name: "three pages sharing a module that imports `node:fs` — exactly ONE diagnostic",
        history:
          "dba54e9: 1. eeaf80f: 4 (1 flat-scan + 3 closure-walk copies, one per reaching page) — round 2's own Important 2. 45e278a: 1, but with no attribution at all.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["pages/b.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["pages/c.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["lib/theme.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "pages/b.tsx", "pages/c.tsx", "lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx"), entry("b", "pages/b.tsx"), entry("c", "pages/c.tsx")],
        errors: ["FORBIDDEN_IMPORT @ lib/theme.ts blocked=[a,b,c]"],
        closures: [],
      },
      {
        name: "a violation in a module NO page reaches is still reported, and the reaching page's own closure is still returned",
        history: "1 diagnostic on all three revisions; only 45e278a and this round return `a`.",
        files: [
          ["pages/a.tsx", META],
          ["lib/orphan.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/orphan.ts"],
        pages: [entry("a", "pages/a.tsx")],
        // No `blocked=` — an orphan's violation blocks nobody's closure, and claiming otherwise
        // would be exactly the kind of false attribution `blockedPages` exists to avoid.
        errors: ["FORBIDDEN_IMPORT @ lib/orphan.ts"],
        closures: ["a: [pages/a.tsx]"],
      },
      {
        name: "a violation in a page's OWN entry is reported exactly once",
        history:
          "dba54e9: 1. eeaf80f: 2 — the same import reported by the flat scan and again by the closure walk. 45e278a: 1.",
        files: [["pages/a.tsx", `import fs from "node:fs"\n${META}`]],
        treePaths: ["pages/a.tsx"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["FORBIDDEN_IMPORT @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "a re-export edge — an edge `scanModuleEdges` does not follow, so the closure it walked is NOT the whole closure",
        history:
          "dba54e9: 2 diagnostics, no closures. eeaf80f AND 45e278a: the same 2 diagnostics but a TRUNCATED closure `a: [pages/a.tsx]` — round 3 Important 2, `lib/theme.ts` missing from it.",
        files: [
          ["pages/a.tsx", `export { x } from "../lib/theme"`],
          ["lib/theme.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        // No NEW diagnostic: the flat scan already reports the re-export exactly once, and the
        // page is attributed onto that very entry rather than getting a second one.
        errors: ["FORBIDDEN_IMPORT @ lib/theme.ts", "REEXPORT @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "a dynamic `import()` edge — same shape, same outcome",
        history: "As the re-export row: eeaf80f and 45e278a both returned `a: [pages/a.tsx]`.",
        files: [
          ["pages/a.tsx", `const m = import("../lib/theme")\n${META}`],
          ["lib/theme.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["DYNAMIC_IMPORT @ pages/a.tsx blocked=[a]", "FORBIDDEN_IMPORT @ lib/theme.ts"],
        closures: [],
      },
      {
        name: "a `require()` edge — same shape, same outcome",
        history: "As the re-export row: eeaf80f and 45e278a both returned `a: [pages/a.tsx]`.",
        files: [
          ["pages/a.tsx", `const m = require("../lib/theme")\n${META}`],
          ["lib/theme.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: ["FORBIDDEN_IMPORT @ lib/theme.ts", "REQUIRE_CALL @ pages/a.tsx blocked=[a]"],
        closures: [],
      },
      {
        name: "a diamond — one shared base reached by two branches appears ONCE in the closure",
        history: "eeaf80f and 45e278a agree with this row; dba54e9 resolved no closures at all.",
        files: [
          [
            "pages/a.tsx",
            `import { l } from "../lib/left"\nimport { r } from "../lib/right"\n${META}`,
          ],
          ["lib/left.ts", `import { b } from "./base"\nexport const l = 1`],
          ["lib/right.ts", `import { b } from "./base"\nexport const r = 1`],
          ["lib/base.ts", `export const b = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/left.ts", "lib/right.ts", "lib/base.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [],
        closures: ["a: [lib/base.ts,lib/left.ts,lib/right.ts,pages/a.tsx]"],
      },
      {
        name: "a cycle terminates and yields the full closure (design §8 step 2 makes a cycle a warning, never a fatal)",
        history: "eeaf80f and 45e278a agree with this row.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/one"\n${META}`],
          ["lib/one.ts", `import { y } from "./two"\nexport const x = 1`],
          ["lib/two.ts", `import { x } from "./one"\nexport const y = 2`],
        ],
        treePaths: ["pages/a.tsx", "lib/one.ts", "lib/two.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [],
        closures: ["a: [lib/one.ts,lib/two.ts,pages/a.tsx]"],
      },
      {
        name: "an extensionless specifier resolving through the `.tsx` probe lands in the closure under its REAL path",
        history: "eeaf80f and 45e278a agree with this row.",
        files: [
          ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
          ["lib/theme.tsx", `export const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/theme.tsx"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [],
        closures: ["a: [lib/theme.tsx,pages/a.tsx]"],
      },
    ];

    for (const row of rows) {
      test(row.name, async () => {
        const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
        const result = await adapter.runTreeImports({
          files: new Map(row.files),
          treePaths: row.treePaths,
          pages: row.pages,
        });
        expect(renderErrors(result.errors)).toEqual([...row.errors]);
        expect(renderClosures(result.closures)).toEqual([...row.closures]);
      });
    }

    test("THE INVARIANT ITSELF, checked over every row rather than per fixture: a page is in `closures` or it is named in some diagnostic's `blockedPages`", async () => {
      // The general statement the rows above are instances of. Written as its own assertion so a
      // NEW row added by a future round is covered by it without anyone remembering to check —
      // and so the property survives even if every individual expectation above were edited.
      for (const row of rows) {
        const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
        const result = await adapter.runTreeImports({
          files: new Map(row.files),
          treePaths: row.treePaths,
          pages: row.pages,
        });
        const resolved = new Set(result.closures.map((closure) => closure.slug));
        const attributed = new Set(result.errors.flatMap((error) => error.blockedPages ?? []));
        for (const page of row.pages) {
          expect({
            row: row.name,
            slug: page.slug,
            resolvedOrAttributed: resolved.has(page.slug) || attributed.has(page.slug),
          }).toEqual({ row: row.name, slug: page.slug, resolvedOrAttributed: true });
        }
        // The other half: never both. A page in `closures` is a page this pass PROVED complete,
        // so nothing may claim its closure was blocked.
        for (const slug of resolved) expect(attributed.has(slug)).toBe(false);
      }
    });

    test("ECONOMY, stated as a property: adding pages that reach an existing violation adds attributions, never diagnostics", async () => {
      // The direct measurement round 2 shipped without: the same tree, once with one page and
      // once with three, comparing the diagnostic list with attribution stripped. Round 1 failed
      // this for `FORBIDDEN_IMPORT` (1 -> 4) and round 2 for `CLOSURE_SOURCE_MISSING` (1 -> 4).
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      // Deliberately mixes BOTH origins in one tree: a flat-scan diagnostic (`UNSCANNED_IMPORT`
      // on the importer, `FORBIDDEN_IMPORT` in a module no page reaches) and a closure-pass one
      // (`CLOSURE_SOURCE_MISSING` on the module with no text) — the second is exactly the code
      // whose count went 1 -> 4 in round 2.
      const shared = new Map<string, string>([
        ["pages/a.tsx", `import { x } from "../lib/theme"\n${META}`],
        ["pages/b.tsx", `import { x } from "../lib/theme"\n${META}`],
        ["pages/c.tsx", `import { x } from "../lib/theme"\n${META}`],
        ["lib/theme.ts", `import { y } from "./tokens"\nexport const x = 1`],
        ["lib/orphan.ts", `import fs from "node:fs"\nexport const z = 1`],
      ]);
      const treePaths = [
        "pages/a.tsx",
        "pages/b.tsx",
        "pages/c.tsx",
        "lib/theme.ts",
        "lib/tokens.ts",
        "lib/orphan.ts",
      ];
      const codesOf = async (pages: readonly PageEntryV1[]) =>
        (await adapter.runTreeImports({ files: shared, treePaths, pages })).errors
          .map((error) => `${error.code} @ ${String(error.file)}`)
          .sort();

      const one = await codesOf([entry("a", "pages/a.tsx")]);
      const three = await codesOf([
        entry("a", "pages/a.tsx"),
        entry("b", "pages/b.tsx"),
        entry("c", "pages/c.tsx"),
      ]);
      expect(three).toEqual(one);
      // Pinned literally too, so this cannot pass by both sides collapsing to nothing.
      expect(one).toEqual([
        "CLOSURE_SOURCE_MISSING @ lib/tokens.ts",
        "FORBIDDEN_IMPORT @ lib/orphan.ts",
        "UNSCANNED_IMPORT @ lib/theme.ts",
      ]);
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

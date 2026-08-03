import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GateErrorV1 } from "core/ports";
import { createFakeGateRunner } from "core/ports/fakes";
import type { PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";
import { RUNTIME_DTS } from "runtime/generated/runtime-dts";

import type { SmokeRenderer, SmokeRequest, SmokeResult } from "../ports/smoke-renderer";
import { createGateRunnerAdapter } from "./gate-runner";

const SLUG = "dash" as PageSlug;

const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

/**
 * Fix round 1 (Important 1): the ONE source shape whose `"jsx"`/`"no-jsx"` readings actually
 * diverge, measured. `readJsxTextRanges` (`gate/model/jsx.ts`) only runs for `"jsx"` — as
 * `"no-jsx"` these are ordinary `<`/`a`/`>`/`{` tokens and the source reads clean. As `"jsx"`,
 * 200 unclosed `<a>{` opens recurse past `MAX_JSX_NESTING_DEPTH` (64) and the reader throws
 * `JsxNestingTooDeepError`. A source with no JSX and no `.ts`-only syntax (e.g. the brief's own
 * title-only fixture) reads identically under both, so it cannot discriminate `parsesJsx
 * (entryRelPath)` from the deleted hardcoded `"jsx"` — reverting `extractPageMeta` to always
 * read `"jsx"` would still pass a test built on one. This one cannot: see the two tests below.
 */
const DEEP_JSX_NESTING = "<a>{".repeat(200);

/** A trivial, offline-runnable fake SmokeRenderer — a fixed scripted result, no host process. */
function fakeSmokeRenderer(result: SmokeResult): SmokeRenderer {
  return { render: async (_request: SmokeRequest) => result };
}

/**
 * Mimics the REAL host `SmokeRenderer` (`host/adapters/smoke-renderer.ts` -> `host/session
 * /model/source-mount.ts`'s `loadPage`): resolves `<treeRoot>/<entryRelPath>` on disk via
 * `Bun.file`, exactly as the real host child process does, instead of returning a scripted
 * result. Used to prove this adapter's tree-coordinate wiring for real — a fixed `{ok:true}`
 * fake (like every other test in this file) would never notice a bare, unresolvable
 * `${slug}.tsx` default under an empty tree root.
 */
function realDiskSmokeRenderer(): SmokeRenderer {
  return {
    render: async (request: SmokeRequest) => {
      const absolute = `${request.treeRoot}/${request.entryRelPath}`;
      const bytes = await Bun.file(absolute)
        .bytes()
        .catch(() => null);
      if (bytes === null) {
        return {
          ok: false,
          code: "SMOKE_SOURCE_UNREADABLE",
          message: `cannot read ${absolute}`,
        };
      }
      return { ok: true };
    },
  };
}

describe("createGateRunnerAdapter", () => {
  test("runPage() passes a clean candidate with a clean smoke render, carrying the descriptor", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runPage({
      source: cleanSource,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    });
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

  test("extractPageMeta reads a .ts entry as TypeScript, not as assumed JSX", async () => {
    // Fix round 1 (Important 1): the brief's own fixture (title-only meta, non-reatomComponent
    // default) can never produce a non-null `meta` at all — `page-contract.ts`'s
    // `validateMetaShape` requires `kitApiVersion`/`theme`/`minSize` alongside `title` before it
    // returns anything but `null` — but completing it to a valid `meta` (this file's first fix
    // round) still did not discriminate: that fixture has no JSX and no `.ts`-only syntax, so
    // both readings agree and the test passed identically under the deleted hardcoded `"jsx"`.
    // `DEEP_JSX_NESTING` (this file's header) is the measured discriminator — read as `"jsx"` it
    // throws past the nesting ceiling; read as `"no-jsx"` (what a `.ts` entry gets) it is inert
    // punctuation and the meta parses clean. See the companion test below for the `.tsx` half.
    const source = `${DEEP_JSX_NESTING}\nexport const meta = definePage({ kitApiVersion: 1, title: "plain", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const extraction = await adapter.extractPageMeta({
      source,
      slug: "plain" as PageSlug,
      entryRelPath: "lib/plain.ts",
    });
    expect(extraction.meta?.title).toBe("plain");
  });

  test("extractPageMeta turns a deep-JSX-nesting throw into an UNSCANNABLE_SOURCE result, not an escaped exception", async () => {
    // The `.tsx` half of the test above's discriminator: the SAME source, read as `"jsx"` this
    // time because the entry is `.tsx`, throws `JsxNestingTooDeepError` out of
    // `checkPageContract` (past `MAX_JSX_NESTING_DEPTH`). Fix round 1 (Important 2):
    // `extractPageMeta` used to let that throw escape uncaught — this pins that it is now
    // converted to an ordinary `{ meta: null, errors: […] }` result instead, the same way
    // `runGate` converts the identical throw (`gate/model/gate.ts`'s own `errore.try`, "an
    // escaping throw would crash the turn instead of rejecting one page" — the identical stakes
    // apply here since this method's one non-test caller, `core/kernel/model/handlers/
    // preview-export.ts`'s `extractAndCachePageMeta`, does not wrap the call in a try/catch of
    // its own either).
    const source = `${DEEP_JSX_NESTING}\nexport const meta = definePage({ kitApiVersion: 1, title: "plain", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const extraction = await adapter.extractPageMeta({
      source,
      slug: "plain" as PageSlug,
      entryRelPath: "lib/plain.tsx",
    });
    expect(extraction.meta).toBeNull();
    expect(extraction.errors[0]?.code).toBe("UNSCANNABLE_SOURCE");
  });

  test("extractPageMeta puts the entry's real tree-relative path in a contract error's `file`", async () => {
    // Fix round 1 (Minor 7): the contract error's `file` is now `input.entryRelPath`, not the
    // deleted `${input.slug}.tsx` guess — an observable output change this suite otherwise never
    // pinned. `SLUG` ("dash") is deliberately unrelated to the entry below.
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const brokenContract = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const extraction = await adapter.extractPageMeta({
      source: brokenContract,
      slug: SLUG,
      entryRelPath: "screens/overview/index.tsx",
    });
    expect(extraction.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  test("runPage() deliberately does not scan imports — the whole-tree scan owns that, and the TURN is what makes it fatal (task 14 wired it; this pins the split, not a gap)", async () => {
    // RETITLED AND RE-FRAMED BY TASK 14. This test used to be called "KNOWN SECURITY GAP, NOT
    // CORRECT BEHAVIOR" and its body said `smokeRan === true` "is the bug, not the feature".
    // Both claims rested on the same premise — that NOTHING in the shipped pipeline called
    // `runTree`, so a forbidden import reached the smoke render undetected. Task 14
    // wired `core/turns/model/validation.ts` to call it once per turn, before any `runPage`,
    // so the premise is now false and the old title asserted a hole that no longer exists. A
    // test that pins a security hole as intended behaviour is worse than no test, which is why
    // this is corrected rather than merely re-passing.
    //
    // WHAT IT PINS NOW, unchanged in substance: `runPage` scans no imports of its own. That is
    // task 12's deliberate design (a shared module belongs to no single page — scanning per
    // page both misses a module no page's own source is run against and reports one violation
    // once per reaching page), and it must stay true or the split silently regresses. It is
    // NOT the wiring proof: this test drives `adapter.runPage(...)` directly, so it would keep
    // passing even if the turn stopped calling `runTree` entirely. That proof lives in
    // `src/entrypoint/model/turn-import-perimeter.test.ts` (the REAL adapter through the REAL
    // `runTurnValidation`, one row per forbidden form in a SHARED module no page names) and in
    // `core/turns/model/validation.test.ts` (the call shape, and that its errors reject the
    // turn). `smokeRan === true` below is therefore correct: the page's own source is clean,
    // and the forbidden import in it is the whole tree's problem, caught before this stage.
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
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    });
    expect(result.errors.some((e) => e.kind === "import")).toBe(false);
    expect(smokeRan).toBe(true);
  });

  test("runTree() catches the SAME forbidden import once per turn, over the whole tree", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const badSource = `import { x } from "lodash"\n${cleanSource}`;
    const result = await adapter.runTree({
      files: new Map([["dash.tsx", badSource]]),
      treePaths: ["dash.tsx"],
      pages: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("import");
    expect(result.errors[0]?.file).toBe("dash.tsx");
  });

  describe("runTree() closures (task-13 review round 1, Critical C1)", () => {
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

      const result = await adapter.runTree({
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

      const result = await adapter.runTree({
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

      const result = await adapter.runTree({
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

  describe("runTree() closure-completeness diagnostics (task-13 review round 2, Important 1)", () => {
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

      const result = await adapter.runTree({
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

      const result = await adapter.runTree({
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

  describe("runTree() no longer duplicates a shared-module violation per reaching page (task-13 review round 2, Important 2)", () => {
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

      const result = await adapter.runTree({
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

  describe("runTree() closure invariant harness (task-13 review round 3)", () => {
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

    /**
     * EVERY field of a diagnostic, not just its shape (task-13 review round 4, M-5): `kind`,
     * `code`, `file`, `line:column` and the full `message` text, plus the blocked slugs. Round
     * 3's renderer compared only `(code, file, blockedPages)`, so a regression that kept the
     * structure and lost the wording or the position would have passed this table — and position
     * was load-bearing in round 3's own Critical (b), where the copy WITH a position is the one
     * that survives. `-` marks a field the diagnostic genuinely does not carry: the closure walk
     * resolves specifiers, not token offsets, so its own diagnostics have no line/column to give
     * and that absence is pinned here rather than papered over with an invented `1:1`.
     *
     * `UNSCANNABLE_SOURCE`'s message ends in the reader's own thrown error text, reproduced
     * verbatim rather than normalized. It used to be Bun's own `RangeError: Maximum call stack
     * size exceeded` — the engine's stack exhausting on this fixture's 32 000-element unterminated
     * body — until the design-tree phase-1 closeout's nesting ceiling (`gate/model/jsx.ts`,
     * `MAX_JSX_NESTING_DEPTH`) started refusing any source this deep, deterministically, long
     * before the engine ever would; that ceiling's own `JsxNestingTooDeepError` is what this
     * fixture now surfaces instead. If either wording changes this row fails loudly and one
     * string is updated — which is the correct outcome, since that text reaches the agent's retry
     * prompt.
     */
    const renderErrors = (errors: readonly GateErrorV1[]): readonly string[] =>
      errors
        .map(
          (error) =>
            `${error.kind}/${error.code} @ ${error.file ?? "-"}:${error.line ?? "-"}:${
              error.column ?? "-"
            }${
              error.blockedPages === undefined ? "" : ` blocked=[${error.blockedPages.join(",")}]`
            } :: ${error.message}`,
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
        errors: [
          'import/CLOSURE_SOURCE_MISSING @ pages/a.tsx:-:- blocked=[a] :: "pages/a.tsx" is named by the tree but this pass was given no source for it, so no page closure reaching it can be verified complete',
        ],
        closures: [],
      },
      {
        name: "an entry absent from `treePaths` — a refusal BEFORE any edge is walked, which the flat scan can never report",
        history:
          "dba54e9: nothing. eeaf80f: 1 UNRESOLVED_IMPORT @ pages/a.tsx. 45e278a: NOTHING — the round-2 deletion lost it (round 3 Critical (a)).",
        files: [["lib/theme.ts", `export const x = 1`]],
        treePaths: ["lib/theme.ts"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [
          'import/UNRESOLVED_IMPORT @ pages/a.tsx:-:- blocked=[a] :: the manifest entry "pages/a.tsx" names no file in the tree, so no closure can be walked from it',
        ],
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
        errors: [
          'import/UNRESOLVED_IMPORT @ pages/a.tsx:-:- blocked=[a] :: the manifest entry "pages/a.tsx" names no file in the tree, so no closure can be walked from it',
        ],
        closures: [],
      },
      {
        name: "a DUPLICATE slug — both limbs of the port's `EXACTLY ONE` would otherwise hold at once",
        history:
          "283d5f6 (the reviewer's own probe): `closures: [a: [pages/a.tsx]]` AND `UNRESOLVED_IMPORT @ pages/ghost.tsx blocked=[a]` — the resolving entry took the first limb while the failing one took the second, falsifying the CONTRACT's absolute (round 4, M-1). dba54e9/eeaf80f: no such check existed.",
        files: [["pages/a.tsx", META]],
        treePaths: ["pages/a.tsx"],
        pages: [entry("a", "pages/a.tsx"), entry("a", "pages/ghost.tsx")],
        // The second entry's OWN diagnostic is still reported — blocking on a duplicate slug must
        // not swallow what is separately wrong with the entry (see `walkPageClosure`).
        errors: [
          'import/UNRESOLVED_IMPORT @ pages/ghost.tsx:-:- blocked=[a] :: the manifest entry "pages/ghost.tsx" names no file in the tree, so no closure can be walked from it',
          'manifest/DUPLICATE_SLUG @ pages.json:-:- blocked=[a] :: "a" is listed more than once, so no closure can be keyed to it',
        ],
        closures: [],
      },
      {
        name: "VALID INPUT STILL PASSES the new duplicate-slug guard: two DIFFERENT slugs may name the SAME entry",
        history:
          "New in round 4. `gate/model/manifest.ts`'s own doc: design §4 makes a duplicate SLUG fatal and a shared ENTRY ordinary — two identities rendering one component is legal.",
        files: [["pages/shared.tsx", META]],
        treePaths: ["pages/shared.tsx"],
        pages: [entry("a", "pages/shared.tsx"), entry("b", "pages/shared.tsx")],
        errors: [],
        closures: ["a: [pages/shared.tsx]", "b: [pages/shared.tsx]"],
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
          'import/CLOSURE_SOURCE_MISSING @ lib/tokens.ts:-:- blocked=[a] :: "lib/tokens.ts" is named by the tree but this pass was given no source for it, so no page closure reaching it can be verified complete',
          'import/UNSCANNED_IMPORT @ lib/theme.ts:1:1 :: "./tokens" resolves to "lib/tokens.ts", which the loader executes but this scan was never given the source of — it cannot be checked for a forbidden import, `eval` or `new Function`',
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
          'import/CLOSURE_SOURCE_MISSING @ lib/tokens.ts:-:- blocked=[a,b,c] :: "lib/tokens.ts" is named by the tree but this pass was given no source for it, so no page closure reaching it can be verified complete',
          'import/UNSCANNED_IMPORT @ lib/theme.ts:1:1 :: "./tokens" resolves to "lib/tokens.ts", which the loader executes but this scan was never given the source of — it cannot be checked for a forbidden import, `eval` or `new Function`',
        ],
        closures: [],
      },
      {
        name: "a file the flat scan cannot tokenize is still FATAL, and still blocks its page, when the closure walk cannot read it either",
        history:
          "dba54e9: 1 (UNSCANNABLE_SOURCE only). eeaf80f: 2 — it reported the `node:fs` import too. 45e278a: 1 — the FORBIDDEN_IMPORT VANISHED (round 3 Critical (b)). task 14b: 1 again, and this time by construction rather than by accident — see below.",
        // CHANGED IN TASK 14b, deliberately, and the security property is unchanged. The closure
        // walk is still run over this file — `readClosureEdges` still refuses to skip a file the
        // flat scan reported `UNSCANNABLE_SOURCE` for, which is round 3's Critical (b) — but
        // `scanModuleEdges` now reads the source through the SAME parse the flat scan uses
        // (`tokenize` -> `readJsxTextRanges` -> `scanJsx`), so this 32 000-element unterminated
        // body trips the same refusal in BOTH readers instead of only the first — originally the
        // engine's own stack exhausting, now `scanJsx`'s `MAX_JSX_NESTING_DEPTH` ceiling firing
        // deterministically long before the stack ever would. The second reader's separate
        // `FORBIDDEN_IMPORT` line is therefore gone either way.
        //
        // That is a loss of DIAGNOSTIC DETAIL, not of enforcement, and the row asserts as much:
        // the fatal is still raised, still attributed to `pages/a.tsx`, and still blocks page
        // `a`, so the turn is rejected exactly as before. Two readers with two different parses
        // is the very hazard task 14b exists to remove — a closure built from a different
        // reading than the allowlist's is what lets an unscanned module load — so the two
        // agreeing here, including about what they cannot read, is the intended outcome.
        files: [["pages/a.tsx", UNSCANNABLE]],
        treePaths: ["pages/a.tsx"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [
          'import/UNSCANNABLE_SOURCE @ pages/a.tsx:1:1 blocked=[a] :: the import scan could not read "pages/a.tsx" to the end — JsxNestingTooDeepError: JSX nesting exceeds the 64-level ceiling at source offset 285',
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
        errors: [
          'import/FORBIDDEN_IMPORT @ lib/theme.ts:1:1 blocked=[a,b,c] :: specifier "node:fs" in lib/theme.ts is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
        ],
        closures: [],
      },
      {
        name: "a violation in a module NO page reaches is still reported, and the reaching page's own closure is still returned",
        // CORRECTED (round 4, M-3): the round-3 wording here said "only 45e278a and this round
        // return `a`", which the reviewer disproved by executing a restored `eeaf80f` — it
        // returns `a: [pages/a.tsx]` too. Only `dba54e9`, which resolved no closures at all,
        // returns none.
        history:
          "1 diagnostic on all three revisions. `dba54e9` returns no closure (it resolved none); `eeaf80f`, `45e278a` and this round all return `a: [pages/a.tsx]`.",
        files: [
          ["pages/a.tsx", META],
          ["lib/orphan.ts", `import fs from "node:fs"\nexport const x = 1`],
        ],
        treePaths: ["pages/a.tsx", "lib/orphan.ts"],
        pages: [entry("a", "pages/a.tsx")],
        // No `blocked=` — an orphan's violation blocks nobody's closure, and claiming otherwise
        // would be exactly the kind of false attribution `blockedPages` exists to avoid.
        errors: [
          'import/FORBIDDEN_IMPORT @ lib/orphan.ts:1:1 :: specifier "node:fs" in lib/orphan.ts is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
        ],
        closures: ["a: [pages/a.tsx]"],
      },
      {
        name: "a violation in a page's OWN entry is reported exactly once",
        history:
          "dba54e9: 1. eeaf80f: 2 — the same import reported by the flat scan and again by the closure walk. 45e278a: 1.",
        files: [["pages/a.tsx", `import fs from "node:fs"\n${META}`]],
        treePaths: ["pages/a.tsx"],
        pages: [entry("a", "pages/a.tsx")],
        errors: [
          'import/FORBIDDEN_IMPORT @ pages/a.tsx:1:1 blocked=[a] :: specifier "node:fs" in pages/a.tsx is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
        ],
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
        errors: [
          'import/FORBIDDEN_IMPORT @ lib/theme.ts:1:1 :: specifier "node:fs" in lib/theme.ts is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
          'import/REEXPORT @ pages/a.tsx:1:1 blocked=[a] :: re-export from "../lib/theme" is not allowed — a page exports no module edge',
        ],
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
        errors: [
          'import/DYNAMIC_IMPORT @ pages/a.tsx:1:11 blocked=[a] :: dynamic import("../lib/theme") is not allowed — a page loads no runtime-selected code',
          'import/FORBIDDEN_IMPORT @ lib/theme.ts:1:1 :: specifier "node:fs" in lib/theme.ts is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
        ],
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
        errors: [
          'import/FORBIDDEN_IMPORT @ lib/theme.ts:1:1 :: specifier "node:fs" in lib/theme.ts is rejected [BARE_SPECIFIER]: only "@termcraft/runtime" and relative specifiers are allowed',
          'import/REQUIRE_CALL @ pages/a.tsx:1:11 blocked=[a] :: require("../lib/theme") is not allowed — a page uses no CommonJS load',
        ],
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
        const result = await adapter.runTree({
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
        const result = await adapter.runTree({
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
        (await adapter.runTree({ files: shared, treePaths, pages })).errors
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

  describe("runTree() import-cycle and dead-module warnings (design-tree phase 2 Task 4)", () => {
    const page = (slug: string, entryPath: string): PageEntryV1 => ({
      slug: slug as PageSlug,
      entry: entryPath,
    });
    const NO_IMPORTS = `export const meta = 1`;

    test("a two-file import cycle is a WARNING, and the turn still passes", async () => {
      // `pages/home.tsx` reaches `lib/two.ts` directly and `lib/one.ts` transitively; `lib/two.ts`
      // and `lib/one.ts` import each other. Named so the cycle's DISCOVERY order (two, then one —
      // the order the walk actually visits them, starting from the entry) differs from the
      // sorted identity order (one, then two) — pinning that the message uses cycle order while
      // `file`/the dedup key use sorted order are two DIFFERENT things, not the same rule stated
      // twice.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/home.tsx", `import { x } from "../lib/two"\n${NO_IMPORTS}`],
        ["lib/two.ts", `import { y } from "./one"\nexport const x = 1`],
        ["lib/one.ts", `import { x } from "./two"\nexport const y = 2`],
      ]);
      const treePaths = ["pages/home.tsx", "lib/two.ts", "lib/one.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx")],
      });

      expect(result.errors).toEqual([]);
      // The closure still resolves — design §8 step 2: a cycle is a warning, never a fatal.
      expect(result.closures).toHaveLength(1);
      const cycleWarnings = result.warnings.filter((w) => w.kind === "import-cycle");
      expect(cycleWarnings).toHaveLength(1);
      const [cycle] = cycleWarnings;
      // Identity: sorted member list, `file` the lexicographically smallest member.
      expect(cycle?.file).toBe("lib/one.ts");
      // The message names every member in CYCLE order (two, then one), NOT sorted order (one,
      // then two) — the exact distinction this task's brief calls out.
      expect(cycle?.message).toBe("an import cycle: lib/two.ts -> lib/one.ts -> lib/two.ts");
    });

    test("a self-import is a cycle too", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/home.tsx", `import { x } from "../lib/self"\n${NO_IMPORTS}`],
        ["lib/self.ts", `import { x } from "./self"\nexport const x = 1`],
      ]);
      const treePaths = ["pages/home.tsx", "lib/self.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx")],
      });

      expect(result.errors).toEqual([]);
      const cycleWarnings = result.warnings.filter((w) => w.kind === "import-cycle");
      expect(cycleWarnings).toHaveLength(1);
      expect(cycleWarnings[0]?.file).toBe("lib/self.ts");
      expect(cycleWarnings[0]?.message).toBe("an import cycle: lib/self.ts -> lib/self.ts");
    });

    test("a module no entry reaches is a `dead-module` warning, once", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/home.tsx", NO_IMPORTS],
        ["lib/orphan.ts", NO_IMPORTS],
      ]);
      const treePaths = ["pages/home.tsx", "lib/orphan.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx")],
      });

      expect(result.errors).toEqual([]);
      const deadWarnings = result.warnings.filter((w) => w.kind === "dead-module");
      expect(deadWarnings).toHaveLength(1);
      expect(deadWarnings[0]?.file).toBe("lib/orphan.ts");
    });

    test("a file reached by ANY entry is never dead", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/home.tsx", NO_IMPORTS],
        ["pages/about.tsx", `import { x } from "../lib/shared"\n${NO_IMPORTS}`],
        ["lib/shared.ts", `export const x = 1`],
      ]);
      const treePaths = ["pages/home.tsx", "pages/about.tsx", "lib/shared.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx"), page("about", "pages/about.tsx")],
      });

      expect(result.errors).toEqual([]);
      expect(result.warnings.filter((w) => w.kind === "dead-module")).toEqual([]);
    });

    test("a non-code tree file is never dead-module", async () => {
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/home.tsx", NO_IMPORTS],
        ["assets/logo.svg", "<svg></svg>"],
      ]);
      const treePaths = ["pages/home.tsx", "assets/logo.svg"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx")],
      });

      expect(result.errors).toEqual([]);
      // `isCodeFile` is false for `.svg` — there is no module here to be dead.
      expect(result.warnings.filter((w) => w.kind === "dead-module")).toEqual([]);
    });

    test("dead-module is suppressed for the WHOLE tree when any entry's closure could not be resolved", async () => {
      // `pages/broken.tsx` imports a module absent from the tree, so its own closure is blocked
      // — and `lib/orphan.ts`, genuinely unreached by anyone, must NOT be reported dead: the
      // reachability picture is incomplete, so a `dead-module` warning built on it would be
      // reporting on a graph this pass never finished reading.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const files = new Map([
        ["pages/broken.tsx", `import { x } from "../lib/missing"\n${NO_IMPORTS}`],
        ["lib/orphan.ts", NO_IMPORTS],
      ]);
      const treePaths = ["pages/broken.tsx", "lib/orphan.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("broken", "pages/broken.tsx")],
      });

      expect(result.closures).toEqual([]);
      expect(result.warnings.filter((w) => w.kind === "dead-module")).toEqual([]);
    });

    test("an unscannable file's edges are unknown, so it is never reported as a cycle member", async () => {
      // The measured shape that defeats the flat scan's JSX reader (mirrors the closure-invariant
      // harness's own `UNSCANNABLE` row above): `lib/tangled.ts` cannot be read to the end by
      // EITHER reader, so its own edges (including any that might close a cycle back through it)
      // are unknown, not empty — it must never surface as an `import-cycle` member.
      const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
      const UNSCANNABLE = `import { x } from "../lib/two"\n${"<a>{".repeat(32000)}`;
      const files = new Map([
        ["pages/home.tsx", `import { x } from "../lib/tangled"\n${NO_IMPORTS}`],
        ["lib/tangled.ts", UNSCANNABLE],
        ["lib/two.ts", `export const x = 1`],
      ]);
      const treePaths = ["pages/home.tsx", "lib/tangled.ts", "lib/two.ts"];

      const result = await adapter.runTree({
        files,
        treePaths,
        pages: [page("home", "pages/home.tsx")],
      });

      expect(result.warnings.filter((w) => w.kind === "import-cycle")).toEqual([]);
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
    const result = await adapter.runPage({
      source: cleanSource,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "smoke" && e.code === "DESIGN_RENDER_FAILED")).toBe(
      true,
    );
  });

  // The "runPage() without compilerAssets/runtimeDts skips the type-check stage" test that used
  // to live here is RETIRED, not merely retitled: design-tree phase 2 Task 3 moved the type check
  // out of `runPage` entirely, so the presence or absence of a compiler no longer changes
  // anything about what `runPage` returns, and a test on it would pin nothing. The honest-omission
  // property it guarded moved with the stage — see the `runTree()` suite at the bottom of this
  // file, which pins both halves (omitted without a compiler; live with one).

  test("runPage() forwards an injected checkManifest port", async () => {
    let checkManifestCalled = false;
    const adapter = createGateRunnerAdapter({
      smokeRenderer: fakeSmokeRenderer({ ok: true }),
      checkManifest: () => {
        checkManifestCalled = true;
        return [];
      },
    });
    await adapter.runPage({
      source: cleanSource,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    });
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

  test("runPage() threads the tree coordinates into the smoke stage so a REAL disk-resolving renderer finds the staged candidate file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-runner-smoke-"));
    const stagedPath = path.join(dir, "dash.tsx");
    fs.writeFileSync(stagedPath, cleanSource);
    try {
      const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
      const result = await adapter.runPage({
        source: cleanSource,
        slug: SLUG,
        treeRoot: dir,
        entryRelPath: "dash.tsx",
        expectedFiles: [{ relPath: "dash.tsx", sha256: "0".repeat(64) }],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runPage() surfaces an unresolvable <treeRoot>/<entryRelPath> as a smoke error rather than a page defect", async () => {
    // `treeRoot`/`expectedFiles` are required inputs now (task 16), so a caller can no longer
    // omit them to reach this path. Fix round 1 (Important 4): the empty-string `treeRoot` this
    // test used to pin is a shape no production caller can construct, and neither field is
    // load-bearing here anyway — measured, this file's own `realDiskSmokeRenderer` above only
    // does `Bun.file(`${treeRoot}/${entryRelPath}`)` and never reads `expectedFiles` at all (the
    // inventory check lives in the real host's `loadPage`, which this fake bypasses). A
    // REALISTIC absolute root that simply has nothing staged under it reproduces the identical
    // "nothing resolves" outcome without pinning an unreachable input shape.
    const adapter = createGateRunnerAdapter({ smokeRenderer: realDiskSmokeRenderer() });
    const result = await adapter.runPage({
      source: cleanSource,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.kind === "smoke" && e.code === "SMOKE_SOURCE_UNREADABLE"),
    ).toBe(true);
  });

  test("runPage() puts the entry's real tree-relative path in a contract error's `file`, even when the entry is unrelated to the slug", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const brokenContract = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await adapter.runPage({
      source: brokenContract,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "screens/overview/index.tsx",
      closure: { entry: "screens/overview/index.tsx", files: ["screens/overview/index.tsx"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  // The `entryRelPath`-out-ranks-`fileName` precedence test that used to live here (task-12
  // review round 1, Important 4) is deleted, not patched: task 16 deleted `fileName` from this
  // port entirely, so there is no precedence left to pin.

  test("contract: an all-clear candidate matches the fake oracle's own default GateRunResultV1 shape", async () => {
    const fake = createFakeGateRunner();
    const real = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const input = {
      source: cleanSource,
      slug: SLUG,
      treeRoot: "/proj/.termcraft/design",
      expectedFiles: [],
      entryRelPath: "pages/dash.tsx",
    };
    const fakeResult = await fake.runPage(input);
    const realResult = await real.runPage(input);
    expect(realResult.ok).toBe(fakeResult.ok);
    expect(realResult.descriptor?.slug).toBe(fakeResult.descriptor?.slug);
  });
});

/**
 * Task 3: the type check now lives INSIDE the whole-tree pass, and each diagnostic is attributed
 * to every page whose closure — the one THIS pass just resolved, never a second walk — contains
 * the file the diagnostic names (design §8 step 5: "A diagnostic in a shared file is attributed
 * to every page whose closure contains it").
 *
 * Driven against the REAL compiler and the REAL generated declaration, for the same reason
 * `gate/model/type-check.test.ts` is: a fake type checker here would prove the plumbing and
 * nothing about the defect this task exists to fix (a page importing a shared module used to
 * fail with a spurious `TS2307` under the per-file program). This is the same TEST-ONLY
 * `gate -> runtime` edge that file's own header documents; production wiring stays in the
 * composition root.
 */
const TSC_EXE = path.join(
  process.cwd(),
  "node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
);
const HAS_TSC = fs.existsSync(TSC_EXE);
const withTsc = HAS_TSC ? test : test.skip;
const TYPE_CHECK_TIMEOUT_MS = 30_000;

/** A shared module both pages below import. Its `WIDTH` initializer is the ONE planted defect. */
const SHARED_CLEAN = `export const TITLE = "Shared"
export const WIDTH: number = 80
`;
const SHARED_BROKEN = `export const TITLE = "Shared"
export const WIDTH: number = "eighty"
`;

/** A page in the shape §5.8 asks agents for, importing the shared module above. */
function consumerPage(title: string, extra = ""): string {
  return `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
import { TITLE, WIDTH } from "../lib/theme"
${extra}
export const meta = definePage({
  kitApiVersion: 1, title: "${title}", minSize: { w: WIDTH, h: 24 }, theme: "dark-default",
})

export default reatomComponent(() => (
  <Panel id="root" title={TITLE}><Text id="label" color="accent">hi</Text></Panel>
), "${title}")
`;
}

const TREE_PATHS = ["lib/theme.ts", "pages/about.tsx", "pages/home.tsx"];
const TREE_PAGES = [
  { slug: "home" as PageSlug, entry: "pages/home.tsx" },
  { slug: "about" as PageSlug, entry: "pages/about.tsx" },
];

function treeAdapter() {
  return createGateRunnerAdapter({
    smokeRenderer: fakeSmokeRenderer({ ok: true }),
    tscExePath: TSC_EXE,
    runtimeDts: RUNTIME_DTS,
  });
}

describe("runTree() — the type check inside the whole-tree pass (design §8 step 5)", () => {
  withTsc(
    "a type error in a SHARED module is reported ONCE, naming the module, and blocks every page whose closure contains it",
    async () => {
      const result = await treeAdapter().runTree({
        files: new Map([
          ["lib/theme.ts", SHARED_BROKEN],
          ["pages/home.tsx", consumerPage("Home")],
          ["pages/about.tsx", consumerPage("About")],
        ]),
        treePaths: TREE_PATHS,
        pages: TREE_PAGES,
      });

      const typeErrors = result.errors.filter((error) => error.kind === "type");
      expect(typeErrors).toHaveLength(1);
      expect(typeErrors[0]?.file).toBe("lib/theme.ts");
      // SORTED, and both pages named: the closure walk this same pass just ran is what says
      // which pages reach `lib/theme.ts` — the diagnostic is not copied once per page.
      expect(typeErrors[0]?.blockedPages).toEqual(["about", "home"] as PageSlug[]);
      // Not a fatal for the tree's structure: closures still resolved for both pages.
      expect(result.closures).toHaveLength(2);
      // Correctly still empty post-Task-4, not merely unfilled: this fixture has no cycle (a
      // one-way `home`/`about` -> `theme` fan-in) and no dead module (`lib/theme.ts` is reached
      // by both pages) — see the dedicated "import-cycle and dead-module warnings" describe
      // block above for the cases where `runTree()` actually populates this field.
      expect(result.warnings).toEqual([]);
    },
    TYPE_CHECK_TIMEOUT_MS,
  );

  withTsc(
    "a type error in ONE page's own entry blocks only that page",
    async () => {
      const result = await treeAdapter().runTree({
        files: new Map([
          ["lib/theme.ts", SHARED_CLEAN],
          ["pages/home.tsx", consumerPage("Home", 'const n: number = "not a number"\n')],
          ["pages/about.tsx", consumerPage("About")],
        ]),
        treePaths: TREE_PATHS,
        pages: TREE_PAGES,
      });

      const typeErrors = result.errors.filter((error) => error.kind === "type");
      expect(typeErrors).toHaveLength(1);
      expect(typeErrors[0]?.file).toBe("pages/home.tsx");
      expect(typeErrors[0]?.blockedPages).toEqual(["home"] as PageSlug[]);
    },
    TYPE_CHECK_TIMEOUT_MS,
  );

  withTsc(
    "a clean tree reports no type errors — and `runPage` reports none for a BROKEN page either, because the stage really left it",
    async () => {
      const adapter = treeAdapter();
      const clean = new Map([
        ["lib/theme.ts", SHARED_CLEAN],
        ["pages/home.tsx", consumerPage("Home")],
        ["pages/about.tsx", consumerPage("About")],
      ]);
      const cleanResult = await adapter.runTree({
        files: clean,
        treePaths: TREE_PATHS,
        pages: TREE_PAGES,
      });
      expect(cleanResult.errors.filter((error) => error.kind === "type")).toEqual([]);

      // The mirror half, and the one that actually proves the move: the SAME page source that
      // `runTree` above rejects for a type error passes `runPage` with no `type` error at all,
      // because `runPage` no longer runs a type check. A test that only checked the clean tree
      // could not tell "the stage moved" from "the stage is silently disabled".
      const brokenPage = consumerPage("Home", 'const n: number = "not a number"\n');
      const brokenTree = await adapter.runTree({
        files: new Map([
          ["lib/theme.ts", SHARED_CLEAN],
          ["pages/home.tsx", brokenPage],
          ["pages/about.tsx", consumerPage("About")],
        ]),
        treePaths: TREE_PATHS,
        pages: TREE_PAGES,
      });
      expect(brokenTree.errors.some((error) => error.kind === "type")).toBe(true);

      const pageResult = await adapter.runPage({
        source: brokenPage,
        slug: "home" as PageSlug,
        treeRoot: "/proj/.termcraft/design",
        expectedFiles: [],
        entryRelPath: "pages/home.tsx",
      });
      expect(pageResult.errors.some((error) => error.kind === "type")).toBe(false);
    },
    TYPE_CHECK_TIMEOUT_MS,
  );

  test("runTree() without tscExePath/runtimeDts skips the type check — an honest omission, never a fabricated pass", async () => {
    const adapter = createGateRunnerAdapter({ smokeRenderer: fakeSmokeRenderer({ ok: true }) });
    const result = await adapter.runTree({
      files: new Map([
        ["lib/theme.ts", SHARED_BROKEN],
        ["pages/home.tsx", consumerPage("Home")],
      ]),
      treePaths: ["lib/theme.ts", "pages/home.tsx"],
      pages: [{ slug: "home" as PageSlug, entry: "pages/home.tsx" }],
    });
    expect(result.errors.some((error) => error.kind === "type")).toBe(false);
  });
});

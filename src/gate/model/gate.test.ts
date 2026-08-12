import { describe, expect, test } from "bun:test";

import type { ClosureV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { GateError } from "../types";
import { runGate, runTreeImports } from "./gate";
import { checkPageContract } from "./page-contract";

const SLUG = "dash" as PageSlug;
const cleanSource = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;
/** `runGate`'s own fixtures always supply a real `entryRelPath` — never the slug-derived
 *  `${slug}.tsx` guess the fallback exists ONLY to bridge a not-yet-updated caller. */
const ENTRY = "pages/dash.tsx";
const CLOSURE: ClosureV1 = { entry: ENTRY, files: [ENTRY] };

const HOME = "home" as PageSlug;

/** Shared minimal fields for the file-stamping tests below — each overrides `entryRelPath`/`source`. */
const base = { slug: SLUG, smoke: "run" as const };

/** Triggers all three token-scannable per-page warning kinds at once: `nondeterministic-time`
 *  (`Date.now()`), `silencing-any` (`: any`), and `unpointed-element` (`<box>` with no `id`). */
const MULTI_WARNING_SOURCE = `import { definePage, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })
const t = Date.now()
const x: any = 1
export default reatomComponent(() => <box>{t}{x}</box>)
`;

/** Declares ids "p"/"t" but never "gone" — pairs with `referencedIds: ["gone"]` to trigger
 *  `dropped-id`, the one lint that stamps no line/column at all (`lints.ts:232-236`). */
const NO_IDS_SOURCE = cleanSource;

describe("runGate (§6.3 pipeline)", () => {
  test("a clean page with no injected stages passes and carries its descriptor", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
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

  test("a contract violation fails the candidate with a contract-kind error and null descriptor", async () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "contract")).toBe(true);
    expect(result.descriptor).toBeNull();
  });

  test("a contract-error's `file` is the entry's real tree-relative path, not a slug-derived guess", async () => {
    // The rule this whole plan exists to establish: which file a page lives in is
    // `pages.json`'s `entry` value. `screens/overview/index.tsx` is deliberately UNRELATED
    // to the slug `dash` — a slug-derived default (`dash.tsx`) would get this wrong.
    const src = `export const meta = definePage({ kitApiVersion: 1, minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: "screens/overview/index.tsx",
      closure: { entry: "screens/overview/index.tsx", files: ["screens/overview/index.tsx"] },
      smoke: "run",
    });
    expect(result.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  // The `entryRelPath`-out-ranks-`fileName` precedence test that used to live here (task-12
  // review round 1, Important 4) is deleted, not patched: task 16 deleted `GateInput.fileName`
  // entirely, so there is no precedence left to pin — see `runGate`'s own comment for the
  // one field that remains.

  test("a determinism warning never fails a candidate", async () => {
    const src = cleanSource.replace("hi", "${Math.random()}");
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "nondeterministic-randomness")).toBe(true);
  });

  test("absent referencedIds skips the dropped-id lint", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
    });
    expect(result.warnings.some((w) => w.kind === "dropped-id")).toBe(false);
  });

  test("a referencedIds entry missing from the candidate warns dropped-id without failing it", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      referencedIds: ["t", "cpu-gauge"],
      smoke: "run",
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => w.kind === "dropped-id" && w.message.includes("cpu-gauge")),
    ).toBe(true);
  });

  test("a raw low-level element without an id warns unpointed-element without failing the candidate", async () => {
    const src = cleanSource.replace('<Text id="t">hi</Text>', "<box>hi</box>");
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "unpointed-element")).toBe(true);
  });

  test("absent listedSlugs skips the unlisted-navigation lint", async () => {
    const src = cleanSource.replace("hi", '${(() => { usePages().goTo("nowhere"); return "" })()}');
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      smoke: "run",
    });
    expect(result.warnings.some((w) => w.kind === "unlisted-navigation")).toBe(false);
  });

  test("navigation to a page absent from listedSlugs warns unlisted-navigation without failing it", async () => {
    const src = cleanSource.replace("hi", '${(() => { usePages().goTo("nowhere"); return "" })()}');
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
      listedSlugs: [SLUG],
      smoke: "run",
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.kind === "unlisted-navigation" && w.message.includes("nowhere"),
      ),
    ).toBe(true);
  });

  // --- every warning a per-page run produces names its file (defect fix, 2026-08-09) ---------

  test("a determinism warning names the entry it was produced against", async () => {
    const result = await runGate({
      ...base,
      entryRelPath: "pages/stopwatch.tsx",
      source: "export const meta = { kitApiVersion: 1 };\nconst t = Date.now();\n",
    });
    const timer = result.warnings.find((w) => w.kind === "nondeterministic-time");
    expect(timer?.file).toBe("pages/stopwatch.tsx");
  });

  test("every warning a per-page run produces carries the same file", async () => {
    const result = await runGate({
      ...base,
      entryRelPath: "pages/a.tsx",
      source: MULTI_WARNING_SOURCE,
    });
    expect(result.warnings.length).toBeGreaterThan(2);
    for (const w of result.warnings) expect(w.file).toBe("pages/a.tsx");
  });

  test("a dropped-id warning, which has no line, still carries its file", async () => {
    // `lintDroppedIds` emits with NO line/column (lints.ts:232-236) — the ONE kind where `file`
    // is the only locator the agent gets, which is exactly why it must not be skipped.
    const result = await runGate({
      ...base,
      entryRelPath: "pages/a.tsx",
      referencedIds: ["gone"],
      source: NO_IDS_SOURCE,
    });
    const dropped = result.warnings.find((w) => w.kind === "dropped-id");
    expect(dropped?.file).toBe("pages/a.tsx");
    expect(dropped?.line).toBeUndefined();
  });

  // The "an injected type-check stage contributes fatal errors" test that used to live here is
  // DELETED, not patched: design-tree phase 2 Task 3 removed `GatePorts.typeCheck` outright.
  // The check now runs once over the whole tree, in `gate/adapters/gate-runner.ts`'s `runTree`,
  // and its own suite proves it there against the REAL compiler — a fake `typeCheck` port here
  // would have pinned a seam that no longer exists.

  test("manifest + smoke stages only run when the page contract is clean", async () => {
    let smokeRan = false;
    const brokenContractSource = `export const meta = definePage({ kitApiVersion: 1, minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    await runGate(
      // `smoke: "run"` deliberately: the EXISTING precondition (nothing fatal yet) is what
      // must keep this candidate out of the smoke stage, not the step-8 scoping added beside it.
      {
        source: brokenContractSource,
        slug: SLUG,
        entryRelPath: ENTRY,
        closure: CLOSURE,
        smoke: "run",
      },
      {
        smokeRender: () => {
          smokeRan = true;
          return [];
        },
      },
    );
    expect(smokeRan).toBe(false); // a contract-broken candidate is never smoke-rendered
  });

  test("the smoke stage runs and contributes errors for a clean-source candidate", async () => {
    const smokeError: GateError = {
      kind: "smoke",
      code: "DESIGN_RENDER_FAILED",
      message: "render threw",
    };
    const result = await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE, smoke: "run" },
      { smokeRender: () => [smokeError] },
    );
    expect(result.errors.some((e) => e.kind === "smoke")).toBe(true);
  });

  // --- design §8 step 8: the caller scopes the smoke stage, and `smoke` has no default -------

  test('`smoke: "skip"` calls no smoke port at all, and still returns the page\'s descriptor', async () => {
    // Step 8's economy: a page whose whole closure is byte-identical to the send-time read set
    // has already been smoke-rendered, so re-rendering it costs a host child process per
    // attempt for an answer that cannot have changed. Everything else about the page still
    // runs — the descriptor below is what the caller needs from an unchanged page.
    let smokeRan = false;
    const result = await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE, smoke: "skip" },
      {
        smokeRender: () => {
          smokeRan = true;
          return [{ kind: "smoke", code: "DESIGN_RENDER_FAILED", message: "render threw" }];
        },
      },
    );
    expect(smokeRan).toBe(false);
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

  test('the identical input with `smoke: "run"` DOES reach the port — no over-fire in the skip test above', async () => {
    let smokeRan = false;
    await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE, smoke: "run" },
      {
        smokeRender: () => {
          smokeRan = true;
          return [];
        },
      },
    );
    expect(smokeRan).toBe(true);
  });

  test('`smoke: "skip"` does not weaken the manifest stage — that one is gated only on the contract', async () => {
    // The new precondition is ADDITIVE, and it is the SMOKE stage's alone: `checkManifest`
    // reads the descriptor, costs no child process, and has nothing to do with which pages
    // changed.
    let manifestRan = false;
    await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE, smoke: "skip" },
      {
        checkManifest: () => {
          manifestRan = true;
          return [];
        },
      },
    );
    expect(manifestRan).toBe(true);
  });

  // --- Step 1's second sample, verbatim (task-12 brief) ---

  test("runPage still refuses to smoke a page whose contract is broken", async () => {
    const result = await runGate(
      {
        source: "export default 1\n",
        slug: HOME,
        entryRelPath: "pages/home.tsx",
        closure: CLOSURE,
        smoke: "run",
      },
      {
        smokeRender: () => {
          throw new Error("smoke must not run");
        },
      },
    );
    expect(result.ok).toBe(false);
  });

  // Moved inside this `describe` (task 5 audit) — the brief's own snippet placed it bare at
  // file top level, which every other `runGate` test here does not; nothing about the test
  // depends on top-level scope, so it is grouped with its siblings rather than left as the
  // one stray case a prior task's review already flagged this exact pattern for (task 3,
  // progress.md).
  test("the display name is the manifest entry, with no slug-derived fallback left", async () => {
    const result = await runGate({
      source: `export const meta = definePage({ title: "t" })\nexport default () => null\n`,
      slug: "home" as PageSlug,
      entryRelPath: "screens/home/index.tsx",
      smoke: "run",
    });
    // `GateWarning.file` is optional (design-tree phase 2 Task 4) but, since the file-stamping
    // fix (defect fix, 2026-08-09, `gate.ts`'s `stamp`), every warning `runGate` itself produces
    // now carries the entry it ran against, same as `gate/adapters/gate-runner.ts`'s whole-tree
    // pass already did for `import-cycle`/`dead-module`. `"file" in error` is a RUNTIME check
    // ("does this diagnostic name a file"), not a type-narrowing one — both union members
    // type-check `.file` directly — but it is kept so the assertion below only ever runs against
    // a diagnostic that actually carries the field, which keeps the brief's intent (no diagnostic
    // of either kind may still carry the slug-derived guess) honestly stated either way.
    for (const error of [...result.errors, ...result.warnings])
      if ("file" in error) expect(error.file).not.toContain("home.tsx");
  });
});

describe("runTreeImports (design §8 step 4 — the whole-tree scan, run once per turn)", () => {
  // --- Step 1's first sample, verbatim (task-12 brief) ---

  test("a forbidden import in a SHARED module fails every page that reaches it", async () => {
    const errors = await runTreeImports({
      files: new Map([
        ["pages/a.tsx", 'import "../lib/theme"\nexport const meta = definePage({})\n'],
        ["pages/b.tsx", 'import "../lib/theme"\n'],
        ["lib/theme.ts", 'import fs from "node:fs"\nexport const theme = 1\n'],
      ]),
      treePaths: ["pages/a.tsx", "pages/b.tsx", "lib/theme.ts"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/theme.ts");
    expect(errors[0]?.kind).toBe("import");
  });

  // --- beyond the brief's own samples (Your Job, step 3) ---

  test("a forbidden import two hops deep in the shared graph still fails every page that transitively reaches it — the whole point of the whole-tree scan", () => {
    const files = new Map([
      ["pages/a.tsx", 'import "../lib/util"\nexport const meta = definePage({})\n'],
      ["pages/b.tsx", 'import "../lib/util"\nexport const meta = definePage({})\n'],
      ["pages/c.tsx", "export const meta = definePage({})\n"],
      ["lib/util.ts", 'import "./theme"\nexport const util = 1\n'],
      ["lib/theme.ts", 'import fs from "node:fs"\nexport const theme = 1\n'],
    ]);
    const errors = runTreeImports({
      files,
      treePaths: [...files.keys()],
    });
    // Exactly one violation, reported ONCE against the module that actually carries it —
    // `pages/a.tsx`/`pages/b.tsx` never reach `node:fs` directly, and the whole-tree scan does
    // not walk closures at all, so it does not (and must not) report the violation once per
    // reaching page; `pages/c.tsx` reaches nothing bad at all.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/theme.ts");
  });

  test("a tree containing a non-TS file that no page imports does not produce a false fatal", () => {
    const files = new Map([
      [
        "pages/home.tsx",
        'import { definePage } from "@termcraft/runtime"\nexport const meta = definePage({})\n',
      ],
    ]);
    // `notes.md` and `assets/icon.svg` are present in the tree's inventory (`store`'s
    // `listTree` enumerates every file under `design/` regardless of extension) but nothing
    // imports either — their mere presence must never itself become a violation.
    const errors = runTreeImports({
      files,
      treePaths: [...files.keys(), "notes.md", "assets/icon.svg"],
    });
    expect(errors).toEqual([]);
  });

  test("a page whose entry is deliberately unrelated to its slug passes end to end through both runTreeImports and runGate", async () => {
    // The slug is "dashboard"; the file it actually lives at has nothing to do with that name
    // — exactly the shape `pages.json`'s `entry` makes legal (design §4: "the agent may move a
    // page's file anywhere in the tree without touching its identity").
    const entry = "widgets/panel-42/render.tsx";
    const source = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;
    const files = new Map([[entry, source]]);
    const treeErrors = runTreeImports({ files, treePaths: [...files.keys()] });
    expect(treeErrors).toEqual([]);

    const dashboardSlug = "dashboard" as PageSlug;
    const result = await runGate({
      source,
      slug: dashboardSlug,
      entryRelPath: entry,
      closure: { entry, files: [entry] },
      smoke: "run",
    });
    expect(result.ok).toBe(true);
    expect(result.errors[0]).toBeUndefined();
  });
});

/**
 * THE PER-PAGE PATH'S TRUNCATION HANDLING (task-14 review round 2, found by mutation while
 * checking M6). `checkPageContract` and the token-based lints return
 * `SourceStreamTruncatedError | …` now, and `runGate` must turn that into a fatal for the page.
 *
 * WHY: mutating `checkPageContract` to swallow the truncation (returning an empty, meta-less
 * result) killed NOTHING in the whole suite. The turn-level tests all place the truncation in a
 * SHARED module, where the whole-tree scan catches it — so the ENTRY-page path, which is the
 * only one `runGate` owns, had no coverage at all.
 */
describe("runGate — a page whose own source cannot be read to the end", () => {
  // RE-POINTED AGAIN in task 14b fix round 1, and the reason IS that round. `tokenize` no longer
  // refuses anything — wherever it cannot classify a span it re-lexes one character on, so it
  // always returns a stream accounting for the whole source. The fail-closed arm therefore lives
  // at its one remaining MEASURED cause: `jsx.ts`'s recursive-descent reader exhausting the
  // engine's stack on absurd nesting, which THROWS. `runGate` converting that into a rejected
  // page rather than a crashed turn is what this block pins.
  const TRUNCATED = "<a>{".repeat(32_000);

  test("the cause really is an engine throw — otherwise the converter below is untested", () => {
    expect(() => checkPageContract(TRUNCATED, "jsx")).toThrow();
  });

  test("rejects the page with UNSCANNABLE_SOURCE instead of reporting a missing contract", async () => {
    const result = await runGate({
      source: TRUNCATED,
      slug: "home" as PageSlug,
      entryRelPath: "pages/home.tsx",
      smoke: "run",
    });
    expect(result.ok).toBe(false);
    // The CODE matters: a truncated stream also has no `meta` in it, so a naive implementation
    // reports "this page declares no meta" — a false diagnosis that sends the agent to fix a
    // contract that is probably fine.
    expect(result.errors.map((e) => e.code)).toEqual(["UNSCANNABLE_SOURCE"]);
    expect(result.descriptor).toBeNull();
  });

  test("the same attribute WITHOUT the trailing backslash is unaffected — no over-fire", async () => {
    // The valid-input companion, one character apart from the fixture above. Without it, a
    // guard that refused every page carrying a JSX attribute would satisfy the assertion above.
    const sameShape = `export const G = () => <Text a="x">hi</Text>\nexport const meta = definePage({ title: "t", minSize: { w: 80, h: 24 }, theme: "dark-default", kitApiVersion: 1 })\n`;
    const kept = await runGate({
      source: sameShape,
      slug: "home" as PageSlug,
      entryRelPath: "pages/home.tsx",
      smoke: "run",
    });
    expect(kept.errors.map((e) => e.code)).not.toContain("UNSCANNABLE_SOURCE");
  });

  test("a page carrying U+FFFD in a STRING is unaffected — no over-fire", async () => {
    const clean = `export const meta = definePage({ title: "\uFFFD", minSize: { w: 80, h: 24 }, theme: "dark-default", kitApiVersion: 1 })\n`;
    const result = await runGate({
      source: clean,
      slug: "home" as PageSlug,
      entryRelPath: "pages/home.tsx",
      smoke: "run",
    });
    expect(result.errors.map((e) => e.code)).not.toContain("UNSCANNABLE_SOURCE");
  });
});

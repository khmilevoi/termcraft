import { describe, expect, test } from "bun:test";

import type { ClosureV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { GateError } from "../types";
import { runGate, runTreeImports } from "./gate";

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

describe("runGate (§6.3 pipeline)", () => {
  test("a clean page with no injected stages passes and carries its descriptor", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
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
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "contract")).toBe(true);
    expect(result.descriptor).toBeNull();
  });

  test("a contract-error's `file` is the entry's real tree-relative path, not a slug-derived guess", async () => {
    // The rule this whole plan exists to establish: which file a page lives in is
    // `pages.json`'s `entry` value. `screens/overview/index.tsx` is deliberately UNRELATED
    // to the slug `dash` — a slug-derived default (`dash.tsx`) would get this wrong.
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: "screens/overview/index.tsx",
      closure: { entry: "screens/overview/index.tsx", files: ["screens/overview/index.tsx"] },
    });
    expect(result.errors[0]?.file).toBe("screens/overview/index.tsx");
  });

  test("a determinism warning never fails a candidate", async () => {
    const src = cleanSource.replace("hi", "${Math.random()}");
    const result = await runGate({
      source: src,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "unguarded-randomness")).toBe(true);
  });

  test("absent referencedIds skips the dropped-id lint", async () => {
    const result = await runGate({
      source: cleanSource,
      slug: SLUG,
      entryRelPath: ENTRY,
      closure: CLOSURE,
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
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.kind === "unlisted-navigation" && w.message.includes("nowhere"),
      ),
    ).toBe(true);
  });

  test("an injected type-check stage contributes fatal errors", async () => {
    const typeError: GateError = {
      kind: "type",
      code: "TYPE_ERROR",
      message: "Type 'string' is not assignable to 'number'",
    };
    const result = await runGate(
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE },
      { typeCheck: () => [typeError] },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "type")).toBe(true);
  });

  test("manifest + smoke stages only run when the contract + type check are clean", async () => {
    let smokeRan = false;
    const brokenContractSource = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    await runGate(
      { source: brokenContractSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE },
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
      { source: cleanSource, slug: SLUG, entryRelPath: ENTRY, closure: CLOSURE },
      { smokeRender: () => [smokeError] },
    );
    expect(result.errors.some((e) => e.kind === "smoke")).toBe(true);
  });

  // --- Step 1's second sample, verbatim (task-12 brief) ---

  test("runPage still refuses to smoke a page whose contract is broken", async () => {
    const result = await runGate(
      {
        source: "export default 1\n",
        slug: HOME,
        entryRelPath: "pages/home.tsx",
        closure: CLOSURE,
      },
      {
        smokeRender: () => {
          throw new Error("smoke must not run");
        },
      },
    );
    expect(result.ok).toBe(false);
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
    });
    expect(result.ok).toBe(true);
    expect(result.errors[0]).toBeUndefined();
  });
});

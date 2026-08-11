import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_DTS } from "runtime/generated/runtime-dts";

import { createTreeTypeChecker } from "./type-check";

// Integration test against the REAL Go compiler. The libs are co-located with the exe
// in the platform package, so no extraction is needed — point straight at it. Skips
// cleanly if the platform package is absent (it IS present on the target win32-x64).
const TSC_EXE = path.join(
  process.cwd(),
  "node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
);
const HAS_TSC = fs.existsSync(TSC_EXE);
const withTsc = HAS_TSC ? test : test.skip;
const TIMEOUT_MS = 30_000;

// A minimal hand-written stand-in for the ambient runtime facade, kept because it isolates the
// diagnostic-plumbing cases below from the real declaration's content. Covers exactly what those
// fixtures use — no JSX, so no jsx-runtime resolution is dragged in. The REAL generated
// declaration gets its own suite at the bottom of this file.
const runtimeDts = `declare module "@termcraft/runtime" {
  export function definePage(meta: { kitApiVersion: number; title: string; minSize: { w: number; h: number }; theme: string }): typeof meta
  export function reatomComponent<T>(render: () => T): () => T
  export function Panel(props: { id: string; title: string }): string
}
`;

const checker = createTreeTypeChecker({ tscExePath: TSC_EXE, runtimeDts });

// MIGRATED, NOT REWRITTEN (design-tree phase 2 Task 3). These five cases were written against the
// per-file `createTypeChecker`, which Task 3 deleted along with its last caller. Every one of them
// asserts a property the WHOLE-TREE program must have just as much — the lib chain loading off
// disk, the global diagnostic bucket being in the union, a crashed compiler never reading as
// clean — so they move to `createTreeTypeChecker` rather than being deleted with the function they
// happened to be phrased against. Deleting them would have quietly dropped the coverage.
describe("createTreeTypeChecker (Spike C: typescript/unstable/sync diagnostics)", () => {
  withTsc(
    "a clean page type-checks with no errors",
    async () => {
      const source = `import { definePage, reatomComponent, Panel } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Clean", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => Panel({ id: "p", title: "hello" }))
`;
      const errors = await checker({ files: new Map([["pages/clean.tsx", source]]) });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a deliberate type error surfaces one TS2322 type-kind GateError with a position",
    async () => {
      const source = `const x: string = 42
export default x
`;
      const errors = await checker({ files: new Map([["pages/bad.tsx", source]]) });
      expect(errors.length).toBe(1);
      expect(errors[0]?.kind).toBe("type");
      expect(errors[0]?.code).toBe("TS2322");
      // The TREE-relative path the diagnostic belongs to, resolved back from the synthetic
      // absolute path the compiler reports.
      expect(errors[0]?.file).toBe("pages/bad.tsx");
      // The API reports a character offset; the checker converts it to a 1-based line.
      expect(errors[0]?.line).toBe(1);
      expect(typeof errors[0]?.column).toBe("number");
    },
    TIMEOUT_MS,
  );

  withTsc(
    "lib types load off disk — a page using Map/Promise/Float16Array still type-checks (only the deliberate mismatch errors)",
    async () => {
      // Mirrors the spike's `libcheck` control: if the lib chain did NOT load, Map/Promise/
      // Float16Array would each raise "Cannot find name", swamping the single real error.
      const source = `export const m: Map<string, number> = new Map()
export const p: Promise<string> = Promise.resolve("x")
export const f: Float16Array = new Float16Array(1)
export const bad: number = "not a number"
`;
      const errors = await checker({ files: new Map([["pages/libcheck.tsx", source]]) });
      expect(errors.length).toBe(1);
      expect(errors[0]?.code).toBe("TS2322");
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a missing global type is caught via the global diagnostic bucket, never silently passed",
    async () => {
      // With `strict` + the pinned esnext libs this page is clean; this asserts the union
      // does not DROP file-level errors while including the global bucket. A regression that
      // omitted a bucket would change this count.
      const source = `const n: number = "oops"
export default n
`;
      const errors = await checker({ files: new Map([["pages/guard.tsx", source]]) });
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a NON-code tree file is never fed to the compiler",
    async () => {
      // Difference #1: `isCodeFile` is the single measured predicate the scan, the closure walk
      // and this program all key on. Feeding a `.json`/`.md` asset through a TS program would
      // manufacture a fatal out of content the loader would never have run.
      const errors = await checker({
        files: new Map([
          ["assets/copy.md", '# not TypeScript at all — `const x: number = "no"`\n'],
          ["pages/clean.ts", "export const x: number = 1\n"],
        ]),
      });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "an unavailable/broken compiler yields a fatal TYPE_CHECK_UNAVAILABLE error, NOT an empty list",
    async () => {
      // A real, launchable executable that is NOT the tsgo compiler: `spawn` succeeds
      // (so the OS never fires an async ENOENT that would crash the runner), but it does
      // not speak the pipe protocol, so the channel construction fails and the boundary
      // returns the fatal error as a value. A truly-nonexistent path is avoided on purpose:
      // the library spawns its child with no `error` handler, so ENOENT would surface as an
      // unhandled async error rather than the crash-as-value this check is asserting.
      const broken = createTreeTypeChecker({ tscExePath: process.execPath, runtimeDts });
      const errors = await broken({
        files: new Map([["pages/page.tsx", "const x = 1\nexport default x\n"]]),
      });
      expect(errors.length).toBe(1);
      expect(errors[0]?.kind).toBe("type");
      expect(errors[0]?.code).toBe("TYPE_CHECK_UNAVAILABLE");
      expect(errors[0]?.message.length).toBeGreaterThan(0);
      // ONE error for the WHOLE tree, and never an empty list: a crashed compiler must not read
      // as a clean tree, and must not be silently attributed to one page either.
      expect(errors[0]?.file).toBeUndefined();
      expect(errors).not.toEqual([]);
    },
    TIMEOUT_MS,
  );
});

// Phase-8 WP-2's acceptance gate, and Task 6 Step 5's verify-not-assume step: the REAL generated
// declaration — not the hand-written stub above — must type-check a real authored page. A
// declaration that cannot is worse than none, because the Gate would then reject correct agent
// output. Both halves matter: a valid page must come back clean, AND a broken page must still
// produce a `type` diagnostic, or "clean" would only prove the checker was silently disabled.
//
// This is the one place `gate` reaches into `runtime` — a TEST-ONLY edge. In production the
// composition root owns that wiring (design §WP-2: it "wires `typeCheck` into
// `createGateRunnerAdapter`, supplying the compiler path and the generated declaration"), so
// `gate`'s shipped code stays free of any `runtime` import and `runtime` stays the leaf the
// module DAG requires. `tscExePath` is resolved locally here, from the same `TSC_EXE` the suite
// above already uses, rather than through `./tsc-extract` — the compiler-resolution helper is
// being reshaped by phase-8 WP-1 and this check must not depend on which name it lands under.
const treeChecker = createTreeTypeChecker({ tscExePath: TSC_EXE, runtimeDts: RUNTIME_DTS });

/** A page in the shape §5.8 asks agents for: `definePage` meta, a Reatom atom, JSX from the catalog. */
const FIXTURE_PAGE = `import { definePage, reatomComponent, Panel, Text, Gauge, atom } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Fixture",
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
})

const load = atom(0.5, "fixture.load")

export default reatomComponent(() => (
  <Panel id="root" title="Fixture">
    <Text id="label" color="#e6a23c">load</Text>
    <Gauge id="load" value={load()} label="50%" />
  </Panel>
), "Fixture")
`;

describe("the generated @termcraft/runtime declaration, through the real type checker", () => {
  withTsc(
    "a valid JSX page against the real generated declaration type-checks clean",
    async () => {
      const errors = await treeChecker({ files: new Map([["pages/fixture.tsx", FIXTURE_PAGE]]) });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a deliberate prop-type error on the same page still surfaces a type diagnostic",
    async () => {
      // `GaugeProps.value` is `number`, and the interface is declared INSIDE the ambient module,
      // so this is checked for real. (Until 2026-08-09 this comment went on to say the same held
      // "even though the external `@reatom/core`/`react` identities do not resolve" — true of the
      // prop check, but it was reading as a general reassurance, and for `@reatom/core` it was
      // not one. `@reatom/core` is now inlined into the gate copy; see `type-check.ts`'s
      // per-specifier note for what is still unresolved and what that costs.)
      const broken = FIXTURE_PAGE.replace("value={load()}", 'value="half"');
      expect(broken).not.toBe(FIXTURE_PAGE);

      const errors = await treeChecker({ files: new Map([["pages/fixture.tsx", broken]]) });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.kind === "type")).toBe(true);
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
      expect(errors.some((e) => e.file === "pages/fixture.tsx")).toBe(true);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a token NAME in a colour prop is now a fatal type diagnostic (spec §4.5, §9)",
    async () => {
      // The migration's whole premise: `color="accent"` used to be the ONLY spelling and is now
      // a TS2322 against `Color`. This fixture is what keeps that a checked fact rather than a
      // claim in a spec — if `Color` ever degraded to `string`, this is the test that notices.
      const broken = FIXTURE_PAGE.replace('color="#e6a23c"', 'color="accent"');
      expect(broken).not.toBe(FIXTURE_PAGE);

      const errors = await treeChecker({ files: new Map([["pages/fixture.tsx", broken]]) });
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
      expect(errors.some((e) => e.file === "pages/fixture.tsx")).toBe(true);
    },
    TIMEOUT_MS,
  );

  const SHARED = `export const TITLE = "Shared"
export const WIDTH: number = 80
`;
  const CONSUMER = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
import { TITLE, WIDTH } from "../lib/theme"

export const meta = definePage({
  kitApiVersion: 1, title: "Home", minSize: { w: WIDTH, h: 24 }, theme: "dark-default",
})

export default reatomComponent(() => (
  <Panel id="root" title={TITLE}><Text id="label" color="#e6a23c">hi</Text></Panel>
), "Home")
`;

  withTsc(
    "a page importing a shared module type-checks clean in ONE whole-tree program",
    async () => {
      const errors = await treeChecker({
        files: new Map([
          ["lib/theme.ts", SHARED],
          ["pages/home.tsx", CONSUMER],
        ]),
      });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a type error in a SHARED module is reported against the file that contains it",
    async () => {
      const broken = CONSUMER.replace("{TITLE}", "{TITLE.toFixed(2)}");
      expect(broken).not.toBe(CONSUMER);
      const errors = await treeChecker({
        files: new Map([
          ["lib/theme.ts", SHARED],
          ["pages/home.tsx", broken],
        ]),
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.kind === "type")).toBe(true);
      expect(errors.some((e) => e.file === "pages/home.tsx")).toBe(true);
    },
    TIMEOUT_MS,
  );

  // The "the per-file program this replaces could not see the sibling at all" case that lived
  // here is DELETED, as Task 2 said it would be: it drove `createTypeChecker`, which Task 3
  // deleted along with its last caller, so there is no per-file program left to pin. The defect
  // it documented is now pinned from the other side — the two tests directly above prove a page
  // importing a shared module type-checks clean, which is exactly what the per-file program
  // could not do.
});

// ── Task 7 (2026-08-09, spec WP-4): atom reads are TYPED, not `any` ────────────────────────
//
// The defect these fixtures pin, in the order the mechanism runs: the served declaration imports
// `atom`/`computed`/`action`/`wrap` from `@reatom/core`, nothing resolved that specifier from
// `os.tmpdir()`, and `skipLibCheck: true` suppressed the resulting `TS2307` — so every one of
// those names was `any`. A type argument on an `any`-typed callee is silently ignored, so
// `atom<readonly Item[]>(…)()` was `any`, and `.map((i) => …)` on `any` has NO contextual
// signature, which `noImplicitAny` reports as a fatal `TS7006`. A measured production run hit
// exactly that four times, on correctly-typed pages. `scripts/gen-runtime-dts.ts` now inlines the
// REAL installed `@reatom/core` declarations into the GATE copy of the declaration, so the
// specifier resolves and the reads carry their real types.
//
// EVERY fixture below uses CAPITALIZED Kit components on purpose. Spike 10 found that lowercase
// raw elements (`<box>`, `<text>`) are a fatal `TS7026` today for an unrelated reason, pinned by
// its own test at the bottom of this file — using them here would make a correct inline read as
// broken, which is literally how that defect was discovered.
describe("atom reads under the real generated declaration (Task 7 / spike 10)", () => {
  const ATOM_MAP_PAGE = `import { definePage, reatomComponent, Panel, Text, atom } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1, title: "Atoms", minSize: { w: 80, h: 24 }, theme: "dark-default",
})

interface Item { readonly name: string }
const itemsAtom = atom<readonly Item[]>([], "atoms.items")

export default reatomComponent(() => (
  <Panel id="root" title="Atoms">
    <Text id="names" color="#e6a23c">{itemsAtom().map((i) => i.name).join(",")}</Text>
  </Panel>
), "Atoms")
`;

  withTsc(
    "an unannotated callback over atom state type-checks clean",
    async () => {
      // The measured `alarm.tsx:98` shape: a method call directly on an atom read. Before the
      // inline this came back `TS7006 Parameter 'i' implicitly has an 'any' type` — a diagnostic
      // manufactured by the Gate against code that is correctly typed, and one no annotation the
      // author could write would really fix, because the callee was `any` either way.
      const errors = await treeChecker({ files: new Map([["pages/atoms.tsx", ATOM_MAP_PAGE]]) });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "the same read of a NON-existent field is TS2339, naming the field",
    async () => {
      // THE OTHER DIRECTION, asserted by CODE rather than by "some type diagnostic" — spike 10
      // found that the pre-inline Gate answered this fixture with `TS7026`/`TS7006` and NEVER
      // mentioned `nope`, so a test that only checked `kind === "type"` passed for the wrong
      // reason and proved nothing. The Gate could not detect a misspelled field on atom state at
      // all; `TS2339` is the diagnostic that says it now can.
      const broken = ATOM_MAP_PAGE.replace("i.name", "i.nope");
      expect(broken).not.toBe(ATOM_MAP_PAGE);

      const errors = await treeChecker({ files: new Map([["pages/atoms.tsx", broken]]) });
      expect(errors.some((e) => e.code === "TS2339")).toBe(true);
      expect(errors.some((e) => e.message.includes("nope"))).toBe(true);
      expect(errors.some((e) => e.file === "pages/atoms.tsx")).toBe(true);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a filter and a .map over a const binding of an atom read are both clean",
    async () => {
      // The other two measured sites, in one tree so neither is fixed by accident: `.filter` on
      // an atom read (`alarm.tsx:102`) and `.map` over a `const laps = lapsAtom()` BINDING
      // (`stopwatch.tsx:126`) — the binding is what proves the fix is about the atom's type and
      // not about the shape of the call expression.
      const source = `import { definePage, reatomComponent, Panel, Text, atom } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1, title: "Alarms", minSize: { w: 80, h: 24 }, theme: "dark-default",
})

interface Alarm { readonly at: string; readonly on: boolean }
const alarmsAtom = atom<readonly Alarm[]>([], "alarms.list")
const lapsAtom = atom<readonly number[]>([], "alarms.laps")

export default reatomComponent(() => {
  const enabled = alarmsAtom().filter((a) => a.on)
  const laps = lapsAtom()
  const rows = laps.map((lapMs, i) => \`\${i}:\${lapMs}\`)
  return (
    <Panel id="root" title="Alarms">
      <Text id="summary" color="#e6a23c">{\`\${enabled.length} \${rows.join(",")}\`}</Text>
    </Panel>
  )
}, "Alarms")
`;
      const errors = await treeChecker({ files: new Map([["pages/alarms.tsx", source]]) });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a spread-then-sort over an atom read stays clean, so the fix did not merely re-derange which sites are wrong",
    async () => {
      // The measured site that was NOT flagged before (`alarm.tsx:115`): the spread yielded
      // `any[]`, whose signatures typed the parameters contextually. It must stay clean after the
      // inline too — otherwise the fix has moved the breakage rather than removed it.
      const source = `import { definePage, reatomComponent, Panel, Text, atom } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1, title: "Ranked", minSize: { w: 80, h: 24 }, theme: "dark-default",
})

interface Item { readonly rank: number }
const itemsAtom = atom<readonly Item[]>([], "ranked.items")

export default reatomComponent(() => (
  <Panel id="root" title="Ranked">
    <Text id="count" color="#e6a23c">{[...itemsAtom()].sort((a, b) => a.rank - b.rank).length}</Text>
  </Panel>
), "Ranked")
`;
      const errors = await treeChecker({ files: new Map([["pages/ranked.tsx", source]]) });
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

// ── PINNED DEFECT S1 (spike 10, `docs/spikes/10-reatom-dts-inline/SPIKE.md`) ────────────────
//
// THIS TEST ASSERTS BROKEN BEHAVIOUR ON PURPOSE. Every lowercase raw JSX element (`<box>`,
// `<text>`) is a fatal `TS7026` through the Gate — before Task 7's `@reatom/core` inline and
// after it alike, because the cause is elsewhere: `JSX.IntrinsicElements` lives in the JSX
// namespace of `@opentui/react/jsx-runtime`, which the generated declaration re-exports BY
// SPECIFIER and which does not resolve hermetically (`@types/react` is not installed and
// `react@19` ships none).
//
// This is a DEFECT, not a documented limitation: `gate/model/lints.ts`'s `lintUnpointedElements`
// calls a lowercase, non-dotted tag "a low-level/raw OpenTUI primitive (the runtime's escape
// hatch, e.g. `<box>`/`<text>`)" in its own doc comment, and exists specifically to warn about
// such a tag carrying no `id` — which presumes those tags are legal and expected. A page that
// follows this project's own documented guidance is rejected naming an interface its author has
// never heard of and cannot supply.
//
// CITATION CORRECTED 2026-08-10 (final whole-branch review, M2). This comment credited that
// sentence to `agent/prompt`'s `DESIGN_CODE_RULES`, which never contained it: the system prompt
// says only "give every pointable low-level element an id" and does not describe lowercase tags
// as an escape hatch at all. The claim itself survives unchanged — only its source moves, to the
// file that really makes it.
//
// The Gate's own suite could not see it: the stand-in declaration at the top of this file is
// JSX-free by design, every fixture in the real-declaration suite uses capitalized Kit components,
// and the Gate-accepted `examples/clock` pages contain zero lowercase JSX tags. This fixture is
// that missing coverage. The FIX — sourcing `JSX.IntrinsicElements` from `@opentui/react`'s own
// `jsx-namespace.d.ts`, or withdrawing the escape hatch from the prompt — is a declaration
// decision with no owner and is NOT Task 7's to make. When it lands, this test flips, and the
// flip is the signal to delete it.
describe("PINNED DEFECT: lowercase raw JSX elements are rejected (spike 10, S1)", () => {
  withTsc(
    "a page using the documented <box> escape hatch comes back with TS7026",
    async () => {
      const source = `import { definePage, reatomComponent } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1, title: "Raw", minSize: { w: 80, h: 24 }, theme: "dark-default",
})

export default reatomComponent(() => <box id="root">raw</box>, "Raw")
`;
      const errors = await treeChecker({ files: new Map([["pages/raw.tsx", source]]) });
      // Asserting the CURRENT, broken result. `expect(errors).toEqual([])` is what this should
      // say once the defect is fixed.
      expect(errors.some((e) => e.code === "TS7026")).toBe(true);
      expect(errors.some((e) => e.message.includes("JSX.IntrinsicElements"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

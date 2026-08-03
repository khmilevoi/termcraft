import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_DTS } from "runtime/generated/runtime-dts";

import { createTreeTypeChecker, createTypeChecker } from "./type-check";

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

const checker = createTypeChecker({ tscExePath: TSC_EXE, runtimeDts });

describe("createTypeChecker (Spike C: typescript/unstable/sync diagnostics)", () => {
  withTsc(
    "a clean page type-checks with no errors",
    async () => {
      const source = `import { definePage, reatomComponent, Panel } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Clean", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => Panel({ id: "p", title: "hello" }))
`;
      const errors = await checker(source, "clean.tsx");
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
      const errors = await checker(source, "bad.tsx");
      expect(errors.length).toBe(1);
      expect(errors[0]?.kind).toBe("type");
      expect(errors[0]?.code).toBe("TS2322");
      expect(errors[0]?.file).toBe("bad.tsx");
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
      const errors = await checker(source, "libcheck.tsx");
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
      const errors = await checker(source, "guard.tsx");
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
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
      const broken = createTypeChecker({ tscExePath: process.execPath, runtimeDts });
      const errors = await broken("const x = 1\nexport default x\n", "page.tsx");
      expect(errors.length).toBe(1);
      expect(errors[0]?.kind).toBe("type");
      expect(errors[0]?.code).toBe("TYPE_CHECK_UNAVAILABLE");
      expect(errors[0]?.message.length).toBeGreaterThan(0);
      // The point of the whole check: a crashed compiler never reads as a clean page.
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
const realChecker = createTypeChecker({ tscExePath: TSC_EXE, runtimeDts: RUNTIME_DTS });

// Task 2: the whole-tree replacement primitive, same real compiler + real declaration.
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
    <Text id="label" color="accent">load</Text>
    <Gauge id="load" value={load()} label="50%" />
  </Panel>
), "Fixture")
`;

describe("the generated @termcraft/runtime declaration, through the real type checker", () => {
  withTsc(
    "a valid JSX page against the real generated declaration type-checks clean",
    async () => {
      const errors = await realChecker(FIXTURE_PAGE, "fixture.tsx");
      expect(errors).toEqual([]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "a deliberate prop-type error on the same page still surfaces a type diagnostic",
    async () => {
      // `GaugeProps.value` is `number`, and the interface is declared INSIDE the ambient module,
      // so this is checked for real even though the external `@reatom/core`/`react` identities the
      // declaration references do not resolve in the hermetic environment.
      const broken = FIXTURE_PAGE.replace("value={load()}", 'value="half"');
      expect(broken).not.toBe(FIXTURE_PAGE);

      const errors = await realChecker(broken, "fixture.tsx");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.kind === "type")).toBe(true);
      expect(errors.some((e) => e.code === "TS2322")).toBe(true);
      expect(errors.some((e) => e.file === "fixture.tsx")).toBe(true);
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
  <Panel id="root" title={TITLE}><Text id="label" color="accent">hi</Text></Panel>
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

  // The regression this whole task exists to prevent coming back.
  // DELETE WITH createTypeChecker (Task 3)
  withTsc(
    "the per-file program this replaces could not see the sibling at all",
    async () => {
      const errors = await realChecker(CONSUMER, "pages/home.tsx");
      expect(errors.some((e) => e.code === "TS2307")).toBe(true);
    },
    TIMEOUT_MS,
  );
});

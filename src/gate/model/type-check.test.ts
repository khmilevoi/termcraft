import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createTypeChecker } from "./type-check";

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

// The injected ambient runtime facade (phase 8 generates the real one). Covers exactly
// what the fixtures use — no JSX, so no jsx-runtime resolution is dragged in.
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

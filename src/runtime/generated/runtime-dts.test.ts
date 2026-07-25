import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_DTS } from "./runtime-dts";

// The generator resolves `@typescript/typescript-${process.platform}-${process.arch}/package.json`
// (`scripts/gen-runtime-dts.ts`) and exits 1 when that per-platform package is absent, so the
// drift check below can only run on a host that has it. Mirrors `gate/model/type-check.test.ts`'s
// HAS_TSC/withTsc guard for the same reason: an environment-dependent native package must not
// hard-fail a suite that would otherwise be portable.
const PLATFORM_TSC_PACKAGE = path.join(
  process.cwd(),
  `node_modules/@typescript/typescript-${process.platform}-${process.arch}/package.json`,
);
const HAS_PLATFORM_TSC = fs.existsSync(PLATFORM_TSC_PACKAGE);
const withPlatformTsc = HAS_PLATFORM_TSC ? test : test.skip;

describe("the generated runtime declaration", () => {
  test("declares the @termcraft/runtime module", () => {
    expect(RUNTIME_DTS).toContain('declare module "@termcraft/runtime"');
  });

  test("carries the page contract and the component catalog", () => {
    for (const name of ["definePage", "PageMeta", "reatomComponent", "Gauge", "Sparkline"]) {
      expect(RUNTIME_DTS).toContain(name);
    }
  });

  if (!HAS_PLATFORM_TSC) {
    console.warn(
      `runtime-dts.test.ts: skipping the fresh-emit drift check — ${PLATFORM_TSC_PACKAGE} is ` +
        "absent on this host, so scripts/gen-runtime-dts.ts cannot run. This does NOT mean the " +
        "committed RUNTIME_DTS is verified fresh; rerun on a host with the platform package, or " +
        "regenerate with `bun run gen:runtime-dts`.",
    );
  }

  withPlatformTsc("matches a fresh emit — regenerate with bun run gen:runtime-dts", async () => {
    const fresh = await Bun.$`bun run scripts/gen-runtime-dts.ts --stdout`.text();
    expect(RUNTIME_DTS.trim()).toBe(fresh.trim());
  });
});

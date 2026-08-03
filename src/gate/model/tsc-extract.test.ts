import { describe, expect, test } from "bun:test";

import { resolveCompilerPath } from "./tsc-extract";
import { createTreeTypeChecker } from "./type-check";

const TIMEOUT_MS = 30_000;

describe("resolveCompilerPath", () => {
  test("resolves a spawnable tsc executable from the installed TypeScript package", () => {
    const resolved = resolveCompilerPath();

    expect(resolved).not.toBeInstanceOf(Error);
    expect(typeof resolved).toBe("string");
    expect(resolved as string).toContain("typescript");
  });

  // Step 5 (VERIFY-NOT-ASSUME, this task's explicit gate): Spike C established that the Go
  // compiler reads its lib chain off REAL DISK itself, next to the executable, rather than
  // through the virtual FS (`type-check.ts`'s own header comment). Deleting `materializeCompiler`
  // means the chain now has to resolve straight from the INSTALLED package layout — this is not
  // assumed, it is proven here by actually type-checking through the resolved path.
  test(
    "the resolved compiler finds its own lib chain",
    async () => {
      const resolved = resolveCompilerPath();
      expect(resolved).not.toBeInstanceOf(Error);

      // A source with no imports still forces the compiler to load its lib chain.
      const diagnostics = await typeCheckFixture(resolved as string, "export const x: number = 1;");
      expect(diagnostics).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // The negative control this gate exists for: without it, a silently unavailable compiler
  // (e.g. a resolution that pointed at nothing, or a lib chain that failed to load) would read
  // as "clean" — indistinguishable from a genuinely valid fixture.
  test(
    "the resolved compiler still reports a deliberate type error, so a silently unavailable compiler cannot read as clean",
    async () => {
      const resolved = resolveCompilerPath();
      expect(resolved).not.toBeInstanceOf(Error);

      const diagnostics = await typeCheckFixture(
        resolved as string,
        'export const x: number = "not a number";',
      );
      expect(diagnostics.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

/** Local helper (this file only — `gate/model/type-check.ts`'s own suite has its own copy):
 *  runs one hermetic check through the module's type-checker entry over a one-file tree, with an
 *  empty `runtimeDts` since the fixtures above import nothing from `@termcraft/runtime`. */
async function typeCheckFixture(tscExePath: string, source: string) {
  const checker = createTreeTypeChecker({ tscExePath, runtimeDts: "" });
  return checker({ files: new Map([["pages/fixture.tsx", source]]) });
}

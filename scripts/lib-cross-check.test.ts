import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { materializeCompiler } from "gate";

import { resolveCompilerAssets } from "./embed-assets";
import { diffLibs, runLibCrossCheckAgainst } from "./lib-cross-check";
import { tscLibNames } from "./tsc-libs.generated";

describe("diffLibs (pure — no compiler spawn)", () => {
  test("askedButNotEmbedded is empty when every asked name is embedded", () => {
    const result = diffLibs({ asked: ["lib.es5.d.ts"], embedded: ["lib.es5.d.ts", "lib.d.ts"] });
    expect(result.askedButNotEmbedded).toEqual([]);
  });

  test("askedButNotEmbedded surfaces a name that was asked for but never embedded", () => {
    const result = diffLibs({
      asked: ["lib.es5.d.ts", "lib.es2015.collection.d.ts"],
      embedded: ["lib.es5.d.ts"],
    });
    expect(result.askedButNotEmbedded).toEqual(["lib.es2015.collection.d.ts"]);
  });

  test("embeddedButNeverAsked surfaces an embedded name the compiler never read (the lib.d.ts sentinel shape)", () => {
    const result = diffLibs({ asked: ["lib.es5.d.ts"], embedded: ["lib.es5.d.ts", "lib.d.ts"] });
    expect(result.embeddedButNeverAsked).toEqual(["lib.d.ts"]);
  });
});

// Integration: spawns the REAL tsc.exe. Skips cleanly when the platform package is absent,
// mirroring `gate/model/type-check.test.ts`'s own `withTsc` pattern.
const TSC_EXE = path.join(
  process.cwd(),
  "node_modules/@typescript/typescript-win32-x64/lib/tsc.exe",
);
const HAS_TSC = fs.existsSync(TSC_EXE);
const withTsc = HAS_TSC ? test : test.skip;
const TIMEOUT_MS = 30_000;

describe("runLibCrossCheckAgainst (Spike C: the 87-asked == curated-set completeness proof)", () => {
  withTsc(
    "the real curated 88-file set embeds everything the compiler asks for — askedButNotEmbedded is []",
    () => {
      const assets = resolveCompilerAssets();
      if (assets instanceof Error) throw assets;
      const exePath = materializeCompiler(assets);
      if (exePath instanceof Error) throw exePath;

      const result = runLibCrossCheckAgainst({
        tscExePath: exePath,
        embeddedLibNames: tscLibNames,
      });
      if (result instanceof Error) throw result;

      expect(result.askedButNotEmbedded).toEqual([]);
      // Spike C found 87 distinct libs asked for (the chain minus the never-read sentinel).
      expect(result.distinctLibsAsked.length).toBeGreaterThan(0);
      expect(result.embeddedButNeverAsked).toEqual(["lib.d.ts"]);
    },
    TIMEOUT_MS,
  );

  withTsc(
    "an artificially-narrowed embedded set is caught: a real, actually-asked-for lib absent from OUR records surfaces in askedButNotEmbedded",
    () => {
      const assets = resolveCompilerAssets();
      if (assets instanceof Error) throw assets;
      const exePath = materializeCompiler(assets);
      if (exePath instanceof Error) throw exePath;

      // The file is still physically present next to tsc.exe (materializeCompiler copied the
      // real curated set) — only OUR bookkeeping of "what we embedded" is missing an entry, so
      // the compiler run still succeeds and this proves the DIFF logic, not a broken compiler.
      const narrowedEmbedded = tscLibNames.filter((name) => name !== "lib.es2015.collection.d.ts");
      const result = runLibCrossCheckAgainst({
        tscExePath: exePath,
        embeddedLibNames: narrowedEmbedded,
      });
      if (result instanceof Error) throw result;

      expect(result.askedButNotEmbedded).toEqual(["lib.es2015.collection.d.ts"]);
    },
    TIMEOUT_MS,
  );
});

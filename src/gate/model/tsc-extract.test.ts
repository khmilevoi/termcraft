import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompilerExtractError, materializeCompiler } from "./tsc-extract";

// A version string no real cache uses, so these tests never collide with a materialized compiler.
const VERSION = "0.0.0-tsc-extract-test";
const LIBS = ["lib.d.ts", "lib.es5.d.ts", "lib.esnext.d.ts"] as const;
const EXE_BYTES = "FAKE-COMPILER-BYTES";
const MARKER = ".extraction-complete";

let assetDir: string;
let cacheRoot: string;

beforeEach(() => {
  assetDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-assets-"));
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cache-"));
  fs.writeFileSync(path.join(assetDir, "tsc.exe"), EXE_BYTES);
  fs.writeFileSync(path.join(assetDir, "lib.d.ts"), "// sentinel");
  fs.writeFileSync(path.join(assetDir, "lib.es5.d.ts"), "// es5");
  fs.writeFileSync(path.join(assetDir, "lib.esnext.d.ts"), "// esnext");
  // A non-lib file must NOT be copied — the extractor only takes `lib.*.d.ts`.
  fs.writeFileSync(path.join(assetDir, "getExePath.js"), "noise");
});

afterEach(() => {
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("materializeCompiler (Spike C: extract tsc-<version> to a per-user cache)", () => {
  test("a fresh extract copies the exe and every lib into tsc-<version>/", () => {
    const result = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (result instanceof Error) throw result;

    const dir = path.dirname(result);
    expect(dir).toBe(path.join(cacheRoot, `tsc-${VERSION}`));
    expect(fs.readFileSync(result, "utf8")).toBe(EXE_BYTES);
    for (const lib of LIBS) expect(fs.existsSync(path.join(dir, lib))).toBe(true);
    // The completion marker is stamped after a complete extraction.
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(true);
    // A non-lib asset is not carried into the cache.
    expect(fs.existsSync(path.join(dir, "getExePath.js"))).toBe(false);
  });

  test("a complete cache is reused — the exe + libs are not re-copied", () => {
    const first = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (first instanceof Error) throw first;

    // The completeness check ignores lib CONTENT, so a post-extract mutation survives
    // a reuse and would be overwritten by a re-extract — a reliable "was it reused?" probe.
    const libPath = path.join(path.dirname(first), "lib.es5.d.ts");
    fs.writeFileSync(libPath, "MUTATED-AFTER-EXTRACT");

    const second = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (second instanceof Error) throw second;
    expect(second).toBe(first);
    expect(fs.readFileSync(libPath, "utf8")).toBe("MUTATED-AFTER-EXTRACT");
  });

  test("a half-cleaned cache (a lib deleted) re-extracts", () => {
    const first = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (first instanceof Error) throw first;

    const libPath = path.join(path.dirname(first), "lib.esnext.d.ts");
    fs.rmSync(libPath);
    expect(fs.existsSync(libPath)).toBe(false);

    const second = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (second instanceof Error) throw second;
    expect(fs.existsSync(libPath)).toBe(true);
    expect(fs.readFileSync(libPath, "utf8")).toBe("// esnext");
  });

  test("a cache missing its completion marker re-extracts (guards a crash mid-extraction)", () => {
    const first = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (first instanceof Error) throw first;

    const dir = path.dirname(first);
    const libPath = path.join(dir, "lib.es5.d.ts");
    fs.writeFileSync(libPath, "MUTATED");
    fs.rmSync(path.join(dir, MARKER));

    const second = materializeCompiler({ assetDir, version: VERSION, cacheRoot });
    if (second instanceof Error) throw second;
    // Re-extracted: the mutated lib is restored and the marker is back.
    expect(fs.readFileSync(libPath, "utf8")).toBe("// es5");
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(true);
  });

  test("a missing asset dir yields a CompilerExtractError, not a throw", () => {
    const result = materializeCompiler({
      assetDir: path.join(assetDir, "does-not-exist"),
      version: VERSION,
      cacheRoot,
    });
    expect(result).toBeInstanceOf(Error);
    expect(CompilerExtractError.is(result)).toBe(true);
  });
});

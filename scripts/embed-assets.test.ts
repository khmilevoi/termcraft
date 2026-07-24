import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AssetStagingError,
  TSC_VERSION,
  resolveCompilerAssets,
  stageEmbeddedAssets,
} from "./embed-assets";

describe("resolveCompilerAssets (WP-11: dev-mode branch — `bun test` never runs compiled)", () => {
  test("under `bun run`/`bun test`, the with-{type:file} import already resolves to the real, collocated node_modules directory, so assetDir is handed straight through with no staging", () => {
    const assets = resolveCompilerAssets();
    if (assets instanceof Error) throw assets;

    expect(assets.version).toBe(TSC_VERSION);
    expect(fs.existsSync(path.join(assets.assetDir, "tsc.exe"))).toBe(true);
    expect(fs.existsSync(path.join(assets.assetDir, "lib.es5.d.ts"))).toBe(true);
    // The real platform package directory, not a staged copy — dev mode does zero I/O here.
    expect(assets.assetDir.replace(/\\/g, "/")).toContain("@typescript/typescript-win32-x64/lib");
  });

  test("an explicit cacheRoot is forwarded verbatim to the returned CompilerAssets", () => {
    const assets = resolveCompilerAssets({ cacheRoot: "Z:/some/cache/root" });
    if (assets instanceof Error) throw assets;
    expect(assets.cacheRoot).toBe("Z:/some/cache/root");
  });

  test("TSC_VERSION matches the installed platform package's own version (never hand-duplicated)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join("node_modules/@typescript/typescript-win32-x64/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(TSC_VERSION).toBe(pkg.version);
  });
});

describe("stageEmbeddedAssets (WP-11: the compiled-binary branch, tested with real files standing in for embedded ones — Spike C's `noembed` panic is what this guards against)", () => {
  let exeSource: string;
  let libDir: string;
  let stagingDir: string;
  const EXE_BYTES = "FAKE-TSC-EXE-BYTES";

  beforeEach(() => {
    libDir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-assets-libs-"));
    exeSource = path.join(libDir, "tsc-hashed.exe"); // hashed name, as a compiled embed would give
    fs.writeFileSync(exeSource, EXE_BYTES);
    fs.writeFileSync(path.join(libDir, "lib.es5.d.ts"), "// es5");
    fs.writeFileSync(path.join(libDir, "lib.esnext.d.ts"), "// esnext");
    stagingDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "embed-assets-stage-")), "nested");
  });

  afterEach(() => {
    fs.rmSync(libDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(stagingDir), { recursive: true, force: true });
  });

  const libSources = () => ({
    "lib.es5.d.ts": path.join(libDir, "lib.es5.d.ts"),
    "lib.esnext.d.ts": path.join(libDir, "lib.esnext.d.ts"),
  });

  test("a fresh stage copies the exe and every lib under their CANONICAL basenames", () => {
    const result = stageEmbeddedAssets({ exeSource, libSources: libSources(), stagingDir });
    if (result instanceof Error) throw result;

    expect(result).toBe(stagingDir);
    expect(fs.readFileSync(path.join(stagingDir, "tsc.exe"), "utf8")).toBe(EXE_BYTES);
    expect(fs.readFileSync(path.join(stagingDir, "lib.es5.d.ts"), "utf8")).toBe("// es5");
    expect(fs.readFileSync(path.join(stagingDir, "lib.esnext.d.ts"), "utf8")).toBe("// esnext");
  });

  test("a complete stage is reused — a post-stage mutation survives a second call", () => {
    const first = stageEmbeddedAssets({ exeSource, libSources: libSources(), stagingDir });
    if (first instanceof Error) throw first;

    const libPath = path.join(stagingDir, "lib.es5.d.ts");
    fs.writeFileSync(libPath, "MUTATED-AFTER-STAGE");

    const second = stageEmbeddedAssets({ exeSource, libSources: libSources(), stagingDir });
    if (second instanceof Error) throw second;
    expect(fs.readFileSync(libPath, "utf8")).toBe("MUTATED-AFTER-STAGE");
  });

  test("a partially-populated stage (a lib missing) re-stages and restores it", () => {
    const first = stageEmbeddedAssets({ exeSource, libSources: libSources(), stagingDir });
    if (first instanceof Error) throw first;

    fs.rmSync(path.join(stagingDir, "lib.esnext.d.ts"));

    const second = stageEmbeddedAssets({ exeSource, libSources: libSources(), stagingDir });
    if (second instanceof Error) throw second;
    expect(fs.readFileSync(path.join(stagingDir, "lib.esnext.d.ts"), "utf8")).toBe("// esnext");
  });

  test("a missing exe source yields an AssetStagingError, not a throw", () => {
    const result = stageEmbeddedAssets({
      exeSource: path.join(libDir, "does-not-exist.exe"),
      libSources: libSources(),
      stagingDir,
    });
    expect(result).toBeInstanceOf(Error);
    expect(AssetStagingError.is(result)).toBe(true);
  });
});

// WP-11 (gap B7, Spike C): embeds `tsc.exe` plus the curated 88-file lib chain into this
// binary's `bun build --compile` module graph via `with { type: "file" }`, and resolves them
// to a `gate.CompilerAssets` (an `assetDir` + `version`) that `materializeCompiler` can
// extract from real disk.
//
// Two runtime shapes, proven empirically (not asserted — see the WP-11 report):
//   * Under `bun run`/`bun test` (never compiled): a `with { type: "file" }` import resolves
//     DIRECTLY to the real, unmoved node_modules path. Every embedded file here still lives
//     in the SAME directory it always did, so `assetDir` is that directory, verbatim — no
//     staging, no extra I/O.
//   * Under `bun build --compile`: the import resolves to a `B:/~BUN/...` (Windows) or
//     `/$bunfs/...` virtual path, and — this is the load-bearing finding — Bun's virtual
//     embedded filesystem does NOT support `fs.readdirSync` on its own root (confirmed:
//     `ENOENT: no such file or directory, scandir 'B:/~BUN/root'`), and by default gives
//     each asset a CONTENT-HASHED basename (`tsc-kmfg705c.exe`, `lib.es5.d-xhkcfhes.ts` —
//     note the hash lands BEFORE the extension, so the lib name no longer even ends in
//     `.d.ts`). `gate/model/tsc-extract.ts`'s `materializeCompiler` expects a real,
//     `readdirSync`-able directory holding canonically-named `tsc.exe` + `lib.*.d.ts` files
//     (that contract is Task 3's, kept unchanged here — see the WP-11 report for why). So
//     this module stages the embedded bytes onto real disk, once, under their CANONICAL
//     names, and hands THAT directory to `materializeCompiler` as `assetDir` — exactly the
//     brief's "embed the assets, pass the resulting assetDir to materializeCompiler" shape.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

import type { CompilerAssets } from "gate";

import tscExePath from "../node_modules/@typescript/typescript-win32-x64/lib/tsc.exe" with { type: "file" };
import platformPackage from "../node_modules/@typescript/typescript-win32-x64/package.json";
import { tscLibPaths } from "./tsc-libs.generated";

/**
 * The pinned compiler's own version, read from the platform package's `package.json` rather
 * than hand-duplicated — `gate/model/tsc-extract.ts`'s `CompilerAssets.version` names the
 * `tsc-<version>/` cache subdirectory, so this must track the ACTUAL installed compiler,
 * never drift from it.
 */
export const TSC_VERSION: string = (platformPackage as { version: string }).version;

/** Staging tsc.exe + the curated libs onto real disk failed (disk full, permissions, ...). */
export class AssetStagingError extends errore.createTaggedError({
  name: "AssetStagingError",
  message: "failed to stage the embedded TypeScript compiler assets to $stagingDir",
}) {}

const EXE_NAME = "tsc.exe";

/** Bun's compiled-executable virtual-FS path prefixes (Windows and the cross-platform form). */
function isEmbeddedPath(p: string): boolean {
  return p.startsWith("B:/~BUN/") || p.startsWith("/$bunfs/");
}

/**
 * True only when every expected file is already on disk with the exe's size matching its
 * embedded source — mirrors `gate/model/tsc-extract.ts`'s own `isCacheComplete` shape (Spike
 * C's "Task 4 could get both by stamping a marker file..." note), so a half-written stage
 * from a killed process re-stages instead of feeding `materializeCompiler` a broken `assetDir`.
 */
function isStageComplete(params: {
  readonly stagingDir: string;
  readonly exeSource: string;
  readonly libNames: readonly string[];
}): boolean {
  const { stagingDir, exeSource, libNames } = params;
  const exe = path.join(stagingDir, EXE_NAME);
  if (!fs.existsSync(exe)) return false;
  if (fs.statSync(exe).size !== fs.statSync(exeSource).size) return false;
  return libNames.every((name) => fs.existsSync(path.join(stagingDir, name)));
}

/**
 * Copy `exeSource` + every `libSources` entry into `stagingDir` under their CANONICAL
 * basenames (`tsc.exe`, `lib.es5.d.ts`, ...), skipping the copy entirely when a complete
 * stage is already there. Takes plain source paths rather than reading the module-level
 * embedded bindings directly so this is testable with real (non-embedded) fixture files —
 * `bun test` never runs compiled, so the embedded branch can never be exercised any other way.
 */
export function stageEmbeddedAssets(params: {
  readonly exeSource: string;
  readonly libSources: Readonly<Record<string, string>>;
  readonly stagingDir: string;
}): AssetStagingError | string {
  const { exeSource, libSources, stagingDir } = params;
  const libNames = Object.keys(libSources);

  return errore.try({
    try: () => {
      if (isStageComplete({ stagingDir, exeSource, libNames })) return stagingDir;
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, EXE_NAME), fs.readFileSync(exeSource));
      for (const name of libNames) {
        fs.writeFileSync(path.join(stagingDir, name), fs.readFileSync(libSources[name]!));
      }
      return stagingDir;
    },
    catch: (cause) => new AssetStagingError({ stagingDir, cause }),
  });
}

export interface ResolveCompilerAssetsDeps {
  /** Forwarded verbatim as `CompilerAssets.cacheRoot` (`materializeCompiler`'s own final,
   *  completeness-marked cache — defaults to `%LOCALAPPDATA%/termcraft` when omitted). */
  readonly cacheRoot?: string;
  /** Where the compiled-binary branch stages canonically-named files before handoff.
   *  Defaults to a version-namespaced directory under the OS temp dir. */
  readonly stagingRoot?: string;
}

/**
 * Resolve this binary's `gate.CompilerAssets` from the embedded (or, in dev, already-real)
 * `tsc.exe` + curated lib chain. Dev mode returns the real node_modules directory verbatim
 * (see the header comment); a compiled binary stages the embedded bytes once under their
 * canonical names and returns that staging directory.
 */
export function resolveCompilerAssets(
  deps: ResolveCompilerAssetsDeps = {},
): AssetStagingError | CompilerAssets {
  const withCacheRoot = (assetDir: string): CompilerAssets => ({
    assetDir,
    version: TSC_VERSION,
    ...(deps.cacheRoot !== undefined ? { cacheRoot: deps.cacheRoot } : {}),
  });

  if (!isEmbeddedPath(tscExePath)) return withCacheRoot(path.dirname(tscExePath));

  const stagingRoot = deps.stagingRoot ?? os.tmpdir();
  const stagingDir = path.join(stagingRoot, `termcraft-tsc-embedded-${TSC_VERSION}`);
  const staged = stageEmbeddedAssets({
    exeSource: tscExePath,
    libSources: tscLibPaths,
    stagingDir,
  });
  if (staged instanceof Error) return staged;
  return withCacheRoot(staged);
}

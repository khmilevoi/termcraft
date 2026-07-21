import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

/**
 * The compiler assets the gate materializes to a per-user cache (Spike C). Phase 3
 * INJECTS `assetDir` (the platform package's `lib/` dir, holding `tsc.exe` + the
 * lib `.d.ts` chain); phase 8 will embed + inject the curated 88-file set. Nothing
 * here embeds assets with `with { type: "file" }` — that is the phase-8 concern.
 */
export interface CompilerAssets {
  /** Directory holding `tsc.exe` and the `lib.*.d.ts` files to extract. */
  readonly assetDir: string;
  /** Compiler version, used as the cache subdirectory name (`tsc-<version>/`). */
  readonly version: string;
  /**
   * Where `tsc-<version>/` is created. Defaults to `%LOCALAPPDATA%/termcraft`
   * (the roadmap's per-user path), falling back to the OS temp dir.
   */
  readonly cacheRoot?: string;
}

/** A fatal failure to materialize the compiler onto real disk (Spike C boundary). */
export class CompilerExtractError extends errore.createTaggedError({
  name: "CompilerExtractError",
  message: "failed to materialize the TypeScript compiler from $assetDir",
}) {}

/** The Windows compiler executable name (Spike C concern #2: this is OS/arch-specific). */
const EXE_NAME = "tsc.exe";

/** Marker stamped ONLY after a fully complete extraction (Spike C latency note, §"Latency"). */
const MARKER_NAME = ".extraction-complete";

/**
 * The default cache root: `%LOCALAPPDATA%/termcraft` per the roadmap's
 * `%LOCALAPPDATA%/termcraft/tsc-<version>/`, falling back to the OS temp dir where
 * `LOCALAPPDATA` is absent (non-Windows / stripped env).
 */
function defaultCacheRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.length > 0)
    return path.join(localAppData, "termcraft");
  return os.tmpdir();
}

/** Every `lib.*.d.ts` in the asset dir — including the `lib.d.ts` startup sentinel. */
function listLibNames(assetDir: string): string[] {
  return fs
    .readdirSync(assetDir)
    .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"));
}

/**
 * A cache is reusable only when a prior extraction COMPLETED (marker present), the
 * exe is present and its size matches the asset exe, and every lib is present. The
 * per-lib presence check (not just the exe) is load-bearing: a half-cleaned cache
 * must re-extract rather than reproduce the `noembed` startup panic Spike C found
 * (a missing `lib.d.ts` next to the exe crashes the Go compiler before any VFS).
 */
function isCacheComplete(params: {
  dir: string;
  exe: string;
  assetExe: string;
  libNames: readonly string[];
}): boolean {
  const { dir, exe, assetExe, libNames } = params;
  if (!fs.existsSync(path.join(dir, MARKER_NAME))) return false;
  if (!fs.existsSync(exe)) return false;
  if (fs.statSync(exe).size !== fs.statSync(assetExe).size) return false;
  return libNames.every((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * Copy the exe + every lib next to it, then stamp the completion marker LAST. The
 * marker is cleared first and written only after every copy, so a crash mid-copy
 * leaves no marker and the next run re-extracts (Spike C concern #4/#5).
 */
function extractCompiler(params: {
  dir: string;
  exe: string;
  assetExe: string;
  assetDir: string;
  libNames: readonly string[];
  version: string;
}): void {
  const { dir, exe, assetExe, assetDir, libNames, version } = params;
  fs.rmSync(path.join(dir, MARKER_NAME), { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(exe, fs.readFileSync(assetExe));
  // The startup sentinel and the lib chain must live next to the exe on real disk —
  // the Go compiler stats/reads them itself, before any virtual FS exists (Spike C).
  for (const name of libNames) {
    fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(assetDir, name)));
  }
  fs.writeFileSync(path.join(dir, MARKER_NAME), version);
}

/**
 * Ensure the TypeScript compiler + its lib `.d.ts` chain are present in
 * `<cacheRoot>/tsc-<version>/` and return the extracted `tsc.exe` path (Spike C:
 * a `bun build --compile` binary cannot spawn an embedded exe, so the compiler is
 * materialized to real disk once per version and reused). All filesystem access is
 * a boundary: a failure is returned as a `CompilerExtractError`, never thrown.
 */
export function materializeCompiler(assets: CompilerAssets): CompilerExtractError | string {
  const cacheRoot = assets.cacheRoot ?? defaultCacheRoot();
  const dir = path.join(cacheRoot, `tsc-${assets.version}`);
  const exe = path.join(dir, EXE_NAME);
  const assetExe = path.join(assets.assetDir, EXE_NAME);

  // The whole filesystem span is one boundary: Node `fs` throws `Error` instances,
  // which `errore.try` wraps into a `CompilerExtractError` value (never thrown).
  return errore.try({
    try: () => {
      const libNames = listLibNames(assets.assetDir);
      if (isCacheComplete({ dir, exe, assetExe, libNames })) return exe;
      extractCompiler({
        dir,
        exe,
        assetExe,
        assetDir: assets.assetDir,
        libNames,
        version: assets.version,
      });
      return exe;
    },
    catch: (e) => new CompilerExtractError({ assetDir: assets.assetDir, cause: e }),
  });
}

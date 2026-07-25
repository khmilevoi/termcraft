import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

/**
 * Resolves a spawnable `tsc` executable straight from the INSTALLED `typescript` package
 * (phase-8 WP-1): there is no embedded/extracted compiler anymore — the dev-only build scripts
 * this module used to hand a materialized cache path to are deleted this task, because they made
 * an npm-installed termcraft unable to even import its own composition root (the deleted scripts
 * lived outside the published package's `files` allowlist, and one of them imported a
 * gitignored, `postinstall`-generated module a fresh clone or install never produces anymore,
 * since that `postinstall` step itself is already gone). `typescript` 7.0.2 (the native Go port)
 * ships its actual compiler in a per-platform package, `@typescript/typescript-<platform>-<arch>`,
 * with `tsc.exe` (`tsc` on non-Windows) and the WHOLE `lib.*.d.ts` chain sitting side by side in
 * that package's `lib/` directory — the Go compiler reads the lib chain off real disk itself,
 * next to the exe, never through the virtual FS (`type-check.ts`'s own header comment; this
 * module's own test "the resolved compiler finds its own lib chain" VERIFIES that holds through
 * this resolution path, per the plan's explicit gate).
 */

/** A failure to resolve the installed TypeScript compiler executable — the `typescript` package,
 *  its platform-specific package, or the resolved executable path itself was not found on disk.
 *  Returned as a VALUE (errore's boundary rule): a missing compiler is an expected, recoverable
 *  condition (an npm install that skipped optional dependencies, an unsupported platform), never
 *  a reason to throw. The class name is unchanged from the pre-WP-1 extraction module so `gate`'s
 *  existing import sites (`gate/index.ts`) do not need to churn their error-type name. */
export class CompilerExtractError extends errore.createTaggedError({
  name: "CompilerExtractError",
  message: "failed to resolve the TypeScript compiler executable: $reason",
}) {}

/**
 * Mirrors `node_modules/typescript/lib/getExePath.js`'s own naming rule — that file is NOT in
 * the package's `exports` map (verified: `node_modules/typescript/package.json`'s `exports`
 * lists only `.`, `./package.json`, and the `./unstable/*` API entry points), so it cannot be
 * imported directly. Its logic is reproduced here instead of hand-building a
 * `node_modules/...` path, so a future change to that naming rule surfaces as a RESOLUTION
 * FAILURE from `Bun.resolveSync` rather than a silently wrong path. `baseName === "typescript"`
 * (the published package, not a fork such as the native-preview line) yields `tsc`; anything
 * else yields `tsgo`.
 */
function expectedBinName(baseName: string): "tsc" | "tsgo" {
  return baseName === "typescript" ? "tsc" : "tsgo";
}

/** `pkg.name`'s trailing segment after the `@scope/` prefix, or the whole name when unscoped —
 *  same split `getExePath.js` performs on the `typescript` package's own `name` field. */
function baseNameOf(pkgName: string): string {
  if (!pkgName.startsWith("@")) return pkgName;
  return pkgName.split("/")[1] ?? pkgName;
}

/** The `typescript` package's own `package.json`, read to derive `baseName` exactly as
 *  `getExePath.js` does — never hand-assumed, since a future rename of the `typescript`
 *  package itself must also change which platform package this resolves. */
function readPackageName(packageJsonPath: string): string {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { name?: unknown };
  return typeof parsed.name === "string" ? parsed.name : "typescript";
}

/** Windows' `MAX_PATH` long-path guard, reproduced verbatim from `getExePath.js`: a resolved
 *  path at or beyond 248 characters needs the `\\?\` prefix to remain openable. */
function withLongPathPrefix(exe: string): string {
  if (process.platform === "win32" && exe.length >= 248) return `\\\\?\\${exe}`;
  return exe;
}

/**
 * Resolve a spawnable `tsc`/`tsgo` executable from the installed `typescript` package through
 * Bun's own module resolution — never a hand-built `node_modules/...` string — so a change in
 * TypeScript's platform-package layout (a renamed package, a missing optional dependency, an
 * unsupported platform) surfaces as a resolution FAILURE here, not a wrong path handed to
 * `spawn`. The lib `.d.ts` chain is NOT resolved separately: it lives in the SAME directory as
 * the executable in the installed layout (verified fact; this module's own test proves the
 * compiler loads it unassisted from there).
 */
export function resolveCompilerPath(): CompilerExtractError | string {
  return errore.try({
    try: () => {
      // Resolved from THIS MODULE's own directory (`import.meta.dir`), never `process.cwd()`.
      // `process.cwd()` is the user's DESIGN PROJECT, which master spec §4.1 guarantees never
      // grows a `package.json` or a `node_modules` — so resolving from there finds `typescript`
      // only by accident, when the cwd happens to sit under termcraft's own development
      // checkout. An installed package launched from any other directory failed outright:
      // `Cannot find module 'typescript/package.json' from '<empty-dir>'`, on both the `export`
      // and interactive argv paths, since `createShell` resolves the compiler eagerly and a
      // failed resolution is a hard `ShellCompositionError`. `import.meta.dir` walks
      // termcraft's OWN node_modules chain, which is where its own dependency actually lives —
      // the same reasoning the platform-package resolution below already applies one level down.
      // A `bun link` probe cannot catch this: the dev checkout's `node_modules` is an ancestor
      // of every cwd inside it, so the wrong base still resolved there.
      const typescriptPackageJsonPath = Bun.resolveSync("typescript/package.json", import.meta.dir);
      const baseName = baseNameOf(readPackageName(typescriptPackageJsonPath));
      const binName = expectedBinName(baseName);

      const platformPackageName = `@typescript/${baseName}-${process.platform}-${process.arch}`;
      // Resolved from the `typescript` package's own path (not `process.cwd()`): the platform
      // package is an optional dependency declared alongside `typescript` itself, so resolving
      // from there follows the same node_modules chain npm/Bun would install it into.
      const platformPackageJsonPath = Bun.resolveSync(
        `${platformPackageName}/package.json`,
        typescriptPackageJsonPath,
      );
      const exeDir = path.join(path.dirname(platformPackageJsonPath), "lib");
      const exeName = process.platform === "win32" ? `${binName}.exe` : binName;
      const exe = withLongPathPrefix(path.join(exeDir, exeName));

      if (!fs.existsSync(exe))
        throw new Error(`resolved executable does not exist on disk: ${exe}`);
      return exe;
    },
    catch: (e) =>
      new CompilerExtractError({ reason: e instanceof Error ? e.message : String(e), cause: e }),
  });
}

import { describe, expect, test } from "bun:test";

import manifest from "../../../package.json" with { type: "json" };

/**
 * Guards the npm-packaging shape decided in phase-8 design §2 ("Distribution
 * decision — npm, not a compiled binary"): termcraft ships as an ordinary,
 * globally-installable npm package run under Bun instead of a per-platform
 * `bun build --compile` binary. That means `package.json` must declare a
 * `termcraft` bin pointing at the production entrypoint, must be publishable
 * (no `private: true`, a semver `version`, a `files` allowlist), and must no
 * longer carry the compiled-binary build machinery (`build`, `build:check`,
 * `postinstall`) that only existed to embed `typescript@7` and cross-check
 * its lib files for that abandoned distribution path.
 */
describe("npm packaging", () => {
  test("declares a termcraft bin that points at the production entrypoint", () => {
    expect(manifest.bin).toEqual({ termcraft: "./src/main.tsx" });
  });

  test("is publishable: not private, carries a version and a files allowlist", () => {
    expect("private" in manifest).toBe(false);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.files).toContain("src");
  });

  // `src/main.tsx` imports `from "entrypoint"` and other bare aliases that resolve only via
  // `tsconfig.json`'s `compilerOptions.paths` (CLAUDE.md: "Bun resolves that same mapping at
  // runtime"). npm force-includes only `package.json`, `README*`, `LICENSE*` and the
  // `main`/`bin` file into a published tarball — never `tsconfig.json` — so an installed
  // package without it in `files` would fail its first aliased import at runtime.
  test("carries tsconfig.json in the files allowlist so aliased imports resolve at runtime", () => {
    expect(manifest.files).toContain("tsconfig.json");
  });

  test("no longer declares the compiled-binary build scripts", () => {
    expect("build" in manifest.scripts).toBe(false);
    expect("build:check" in manifest.scripts).toBe(false);
    expect("postinstall" in manifest.scripts).toBe(false);
  });
});

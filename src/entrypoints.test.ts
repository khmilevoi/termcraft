import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { parseHostArgs } from "host/session";

/**
 * The executable-surface contract: `package.json`'s commands and the two runnable roots must
 * stay in sync. A script that points at a deleted root, or a root that starts the terminal on
 * plain `import`, both break the documented workflow without failing any module's own tests.
 */

const repoRoot = path.resolve(import.meta.dir, "..");

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8")) as Record<
    string,
    unknown
  >;
}

const scripts = readJson("package.json").scripts as Record<string, string>;

/** Every `src/...` path a script names, so the assertion follows the script, not a hardcoded list. */
function referencedRoots(command: string): readonly string[] {
  return [...command.matchAll(/src\/[\w./-]+/g)].map((match) => match[0]);
}

describe("package entrypoints", () => {
  test("declares the four documented commands", () => {
    expect(Object.keys(scripts)).toEqual(expect.arrayContaining(["start", "dev", "demo", "build"]));
  });

  test.each(["start", "dev", "demo", "build"])("`%s` points at an existing root", (name) => {
    const roots = referencedRoots(scripts[name] ?? "");
    expect(roots).not.toEqual([]);
    for (const root of roots) expect(fs.existsSync(path.join(repoRoot, root))).toBe(true);
  });

  test("`dev` runs the interactive root under watch mode", () => {
    expect(scripts.dev).toContain("--watch");
    expect(referencedRoots(scripts.dev ?? "")).toEqual(referencedRoots(scripts.start ?? ""));
  });

  test("`build` compiles a standalone executable", () => {
    expect(scripts.build).toContain("--compile");
    expect(scripts.build).toContain("dist/termcraft");
  });

  test.each(["src/main.tsx", "src/demo.tsx"])("%s only starts under import.meta.main", (root) => {
    expect(fs.readFileSync(path.join(repoRoot, root), "utf8")).toContain("import.meta.main");
  });

  test("`_host --stdio` argv is recognized ahead of the interactive bootstrap", () => {
    expect(parseHostArgs(["exe", "_host", "--stdio"])).toBe(true);

    // The interactive bootstrap must never run for a `_host` argv (Spike E): the
    // dispatch branch has to appear before `bootstrap("interactive"...` in source
    // order, so the interactive path only ever sits in its `else`.
    const mainSource = fs.readFileSync(path.join(repoRoot, "src/main.tsx"), "utf8");
    const dispatchIndex = mainSource.indexOf("parseHostArgs");
    const bootstrapIndex = mainSource.indexOf('bootstrap("interactive"');
    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(dispatchIndex).toBeLessThan(bootstrapIndex);
  });
});

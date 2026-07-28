import { describe, expect, test } from "bun:test";

import { RUNTIME_ROOT_SPECIFIER, resolveDesignSpecifier } from "./specifier";

const TREE = new Set([
  "pages/dashboard.tsx",
  "pages/calendar.tsx",
  "lib/theme.ts",
  "lib/index.ts",
  "lib/index/inner.ts",
  "widgets/gauge.tsx",
  "pages.json",
  "notes.md",
]);
const has = (relPath: string) => TREE.has(relPath);

function resolve(from: string, specifier: string) {
  return resolveDesignSpecifier({ from, specifier, has });
}

describe("resolveDesignSpecifier", () => {
  test("the bare runtime root resolves to the runtime, not a file", () => {
    expect(resolve("pages/dashboard.tsx", RUNTIME_ROOT_SPECIFIER)).toEqual({ kind: "runtime" });
  });

  test("an explicit extension is used as written", () => {
    expect(resolve("pages/dashboard.tsx", "../lib/theme.ts")).toEqual({
      kind: "file",
      relPath: "lib/theme.ts",
    });
    expect(resolve("pages/dashboard.tsx", "../widgets/gauge.tsx")).toEqual({
      kind: "file",
      relPath: "widgets/gauge.tsx",
    });
  });

  test("an extensionless specifier probes .tsx then .ts and stops", () => {
    expect(resolve("pages/dashboard.tsx", "../lib/theme")).toEqual({
      kind: "file",
      relPath: "lib/theme.ts",
    });
    // `widgets/gauge.tsx` exists, so `.tsx` wins before `.ts` is tried.
    expect(resolve("pages/dashboard.tsx", "../widgets/gauge")).toEqual({
      kind: "file",
      relPath: "widgets/gauge.tsx",
    });
  });

  test("there is NO directory-index resolution", () => {
    // `lib/index.ts` exists, but `../lib` must not resolve to it.
    const result = resolve("pages/dashboard.tsx", "../lib");
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("UNRESOLVED");
  });

  test("only .tsx and .ts are probed", () => {
    expect(resolve("pages/dashboard.tsx", "../notes")).toBeInstanceOf(Error);
    // …but an explicit extension for a real non-source file DOES resolve; the import scan,
    // not the resolver, is what decides which file kinds may be imported.
    expect(resolve("pages/dashboard.tsx", "../notes.md")).toEqual({
      kind: "file",
      relPath: "notes.md",
    });
  });

  test("`./` and nested `../` normalize inside the tree", () => {
    expect(resolve("pages/dashboard.tsx", "./calendar.tsx")).toEqual({
      kind: "file",
      relPath: "pages/calendar.tsx",
    });
    expect(resolve("lib/index/inner.ts", "../../pages/calendar.tsx")).toEqual({
      kind: "file",
      relPath: "pages/calendar.tsx",
    });
  });

  test("a specifier escaping the tree is rejected", () => {
    for (const spec of ["../../secret.ts", "../../../etc/passwd", "./../../x.ts"]) {
      const result = resolve("pages/dashboard.tsx", spec);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("ESCAPES_TREE");
    }
  });

  test("a query string or fragment is rejected", () => {
    for (const spec of ["../lib/theme.ts?raw", "../lib/theme.ts#frag", "../lib/theme?x=1"]) {
      const result = resolve("pages/dashboard.tsx", spec);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("QUERY_OR_FRAGMENT");
    }
  });

  test("any other bare specifier is rejected, node: included", () => {
    for (const spec of ["react", "node:fs", "@termcraft/runtime/ui", "lib/theme.ts", "/abs.ts"]) {
      const result = resolve("pages/dashboard.tsx", spec);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("BARE_SPECIFIER");
    }
  });

  test("a backslash is rejected rather than translated", () => {
    const result = resolve("pages/dashboard.tsx", ".\\calendar.tsx");
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain("BACKSLASH");
  });
});

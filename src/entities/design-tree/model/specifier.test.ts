import { describe, expect, test } from "bun:test";

import { RUNTIME_ROOT_SPECIFIER, resolveDesignSpecifier } from "./specifier";
import type { SpecifierRejectionCodeV1 } from "./specifier";

const TREE = new Set([
  "pages/dashboard.tsx",
  "pages/calendar.tsx",
  "lib/theme.ts",
  "lib/index.ts",
  "lib/index/inner.ts",
  "widgets/gauge.tsx",
  "widgets/panel.jsx",
  "widgets/index.tsx",
  "pages.json",
  "notes.md",
]);
const has = (relPath: string) => TREE.has(relPath);

function resolve(from: string, specifier: string) {
  return resolveDesignSpecifier({ from, specifier, has });
}

/**
 * Assert a rejection AND which rule fired. `toBeInstanceOf(Error)` alone can't tell a
 * correctly-rejected specifier from one rejected for the wrong reason — a perimeter test that
 * only checks "is this an Error" would stay green through a `normalizeRelative` refactor that
 * quietly swapped which code fires.
 */
function expectRejected(from: string, specifier: string, code: SpecifierRejectionCodeV1) {
  const result = resolve(from, specifier);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) return;
  expect(result.code).toBe(code);
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
    expectRejected("pages/dashboard.tsx", "../lib", "UNRESOLVED");
  });

  test("only .tsx and .ts are probed", () => {
    expectRejected("pages/dashboard.tsx", "../notes", "UNRESOLVED");
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
      expectRejected("pages/dashboard.tsx", spec, "ESCAPES_TREE");
    }
  });

  test("a query string or fragment is rejected", () => {
    for (const spec of ["../lib/theme.ts?raw", "../lib/theme.ts#frag", "../lib/theme?x=1"]) {
      expectRejected("pages/dashboard.tsx", spec, "QUERY_OR_FRAGMENT");
    }
  });

  test("any other bare specifier is rejected, node: included", () => {
    for (const spec of ["react", "node:fs", "@termcraft/runtime/ui", "lib/theme.ts", "/abs.ts"]) {
      expectRejected("pages/dashboard.tsx", spec, "BARE_SPECIFIER");
    }
  });

  test("only the exact runtime string is the runtime; every neighbour is a bare specifier", () => {
    // A prefix/suffix/subpath/query neighbour of `@termcraft/runtime` must NOT be treated as
    // the runtime root — only byte-for-byte equality qualifies (design §6 rule 1).
    for (const spec of [
      "@termcraft/runtime-extra",
      "@termcraft/runtime/",
      "@termcraft/runtime/ui",
      "@termcraft/runtime?x",
    ]) {
      expectRejected("pages/dashboard.tsx", spec, "BARE_SPECIFIER");
    }
  });

  test("a backslash is rejected rather than translated, leading or embedded", () => {
    // Leading `.\` (the classic Windows-relative typo) and a backslash embedded mid-path both
    // must be refused outright — never silently translated to a forward slash.
    for (const spec of [".\\calendar.tsx", "../lib\\theme.ts"]) {
      expectRejected("pages/dashboard.tsx", spec, "BACKSLASH");
    }
  });

  test("a specifier whose last segment is a trailing slash or a bare `.` names a directory", () => {
    // Each of these would, without a directory-form check, either resolve to an existing
    // sibling file (dropping the trailing slash/dot silently) or probe the importer's own
    // directory as a file basename. Neither is legal: §6 grants no directory-index resolution.
    for (const spec of ["./calendar.tsx/", "./calendar.tsx//", "../lib/theme.ts/", "./", "./."]) {
      expectRejected("pages/dashboard.tsx", spec, "UNRESOLVED");
    }
  });

  test("bare `.` and bare `..` are classified honestly, not lumped into BARE_SPECIFIER", () => {
    // Both are valid ESM relative specifiers, so neither may be told "only relative specifiers
    // are allowed" — the message would be false. `.` names the importer's own directory
    // (UNRESOLVED); `..` normalizes to exactly the tree root (ESCAPES_TREE).
    expectRejected("pages/dashboard.tsx", ".", "UNRESOLVED");
    expectRejected("pages/dashboard.tsx", "..", "ESCAPES_TREE");
  });

  test("normalization tricks stay inside, land at the root, or escape — never resolve wrongly", () => {
    // Stays inside the tree (net effect is a single `../` back to design/'s top level), but
    // there is no file named `x` there.
    expectRejected("pages/dashboard.tsx", "./a/../../x", "UNRESOLVED");
    // A doubled slash collapses like an empty segment; still lands on a nonexistent `x`.
    expectRejected("pages/dashboard.tsx", ".//../x", "UNRESOLVED");
    // Lands exactly on the tree root (`pages` popped by the trailing `..`).
    expectRejected("pages/dashboard.tsx", "./..", "ESCAPES_TREE");
    // One `..` too many: climbs above the tree root entirely.
    expectRejected("pages/dashboard.tsx", "./a/../../../x", "ESCAPES_TREE");
  });

  test("a percent-encoded traversal is never decoded", () => {
    // If `%2e%2e` were decoded to `..`, this would pop `pages` and then climb above the root
    // (ESCAPES_TREE). Treated as a literal path segment, it stays inside the tree and simply
    // fails to name a file (UNRESOLVED) — proving no decoding happened.
    expectRejected("pages/dashboard.tsx", "./%2e%2e/%2e%2e/x", "UNRESOLVED");
  });

  test("the extension probe never reaches a third extension, an index file, or an explicit extension's own file", () => {
    // `widgets/panel.jsx` exists, but `.jsx` is not in RESOLUTION_EXTENSIONS.
    expectRejected("pages/dashboard.tsx", "../widgets/panel", "UNRESOLVED");
    // `widgets/index.tsx` exists, but a bare directory name never implies its index file.
    expectRejected("pages/dashboard.tsx", "../widgets", "UNRESOLVED");
    // An explicit `.js` extension is used as written; it must not become `theme.js.ts`.
    expectRejected("pages/dashboard.tsx", "../lib/theme.js", "UNRESOLVED");
  });
});

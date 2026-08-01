import { describe, expect, test } from "bun:test";

import { resolveClosure } from "entities/design-tree";

import { scanModuleEdges, scanTreeImports } from "./tree-scan";

describe("scanTreeImports (design §6, §8 step 4 — the whole-tree authoritative scan)", () => {
  test("scanTreeImports reports the file each violation is in", () => {
    const errors = scanTreeImports({
      files: new Map([
        ["pages/dashboard.tsx", 'import "../lib/theme"\n'],
        ["lib/theme.ts", 'import fs from "node:fs"\n'],
      ]),
      has: (relPath) => relPath === "lib/theme.ts",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/theme.ts");
  });

  describe("task-11 review, Important 2 — a CODE resolution target absent from `files` can never launder an unscanned module", () => {
    test("a `has` that affirms a `.ts` path never present in `files` does not let a relative import resolve to it", () => {
      // The review's own reproduction, re-pinned against a `.ts` target — see the task-12
      // review of this file's contract, above `scanTreeImports`: only a CODE target is held to
      // the "must also be a key in `files`" bar, because only that kind of file could itself
      // hide a further forbidden import this pass never read. `has` answers true for
      // "lib/legacy.ts" but `files` was never given its source — this pass never actually
      // scanned it. If `has` alone were trusted, the import below would resolve cleanly and
      // "lib/legacy.ts" would load into a page having never itself been scanned for a
      // forbidden import.
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/legacy.ts"\n']]),
        has: (relPath) => relPath === "lib/legacy.ts" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
    });

    test("the SAME `.ts` path is legal once it is also a real key in `files` — the enforcement is an intersection, not an outright ban", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/legacy.ts"\n'],
          ["lib/legacy.ts", "export const x = 1\n"],
        ]),
        has: (relPath) => relPath === "lib/legacy.ts" || relPath === "pages/home.tsx",
      });
      expect(errors).toEqual([]);
    });

    test("task-12 review round 1, Important 3 — a `.js` target `has` affirms but `files` never scanned is STILL fatal, not just `.ts`/`.tsx`", () => {
      // The task-11 review's OWN original reproduction used `.js`. An earlier draft of this
      // fix keyed the enforcement on `entities/design-tree`'s `RESOLUTION_EXTENSIONS` (the
      // EXTENSIONLESS-PROBE list, `.tsx`/`.ts` only) rather than "is this file code", which
      // silently re-opened exactly this hole: a `.js` module could resolve cleanly without
      // ever being scanned, because `RESOLUTION_EXTENSIONS` was never about `.js` at all.
      // `.js`/`.jsx`/`.mjs`/`.cjs` all carry the same import/eval/Function surface `.ts`/`.tsx`
      // does, so they get the same "must also be a key in `files`" treatment.
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/legacy.js"\n']]),
        has: (relPath) => relPath === "lib/legacy.js" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
    });

    test("a legitimate cross-file import of a NON-code tree file resolves cleanly even though this pass never scanned its text — the false-fatal the task-12 review closed", () => {
      // `config.json` is affirmed by `has` (the whole-tree inventory `store`'s `listTree`
      // would report) but was never given text in `files` — exactly the shape the task-11
      // draft turned into a false UNRESOLVED_IMPORT purely because of a bare `.json`
      // extension, unrelated to anything actually wrong with the file.
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import config from "../config.json"\n']]),
        has: (relPath) => relPath === "config.json" || relPath === "pages/home.tsx",
      });
      expect(errors).toEqual([]);
    });

    test("a non-TS tree file nothing imports never produces a fatal merely from its own presence in the tree", () => {
      // `store`'s `listTree` enumerates every file under `design/` regardless of extension, so
      // a real tree legitimately carries files no page ever imports — `notes.md` here. Its
      // mere membership in `has`'s inventory must never itself become a violation.
      const errors = scanTreeImports({
        files: new Map([
          [
            "pages/home.tsx",
            'import { definePage } from "@termcraft/runtime"\nexport const meta = definePage({})\n',
          ],
        ]),
        has: (relPath) => relPath === "pages/home.tsx" || relPath === "notes.md",
      });
      expect(errors).toEqual([]);
    });
  });

  describe("task-12 review round 1, Important 2 — a non-code file's own TEXT is never tokenized as JS/TS, even when it sits in `files`", () => {
    test("a `.md` file whose prose merely spells `eval` produces no violation — scanning it as JS/TS would be the false fatal", () => {
      // Before this fix: `scanTreeImports` fed EVERY `files` entry through the full JS/TS
      // allowlist scan unconditionally, so this exact prose tripped `EVAL_CALL` — a real
      // false fatal on content that is not code at all (task-12 review round 1).
      const errors = scanTreeImports({
        files: new Map([["notes.md", "Do not use eval in pages.\n"]]),
        has: () => true,
      });
      expect(errors).toEqual([]);
    });

    test('a `.json` asset containing the literal strings "eval"/"Function" produces no violation', () => {
      const errors = scanTreeImports({
        files: new Map([["data.json", '["eval", "Function"]\n']]),
        has: () => true,
      });
      expect(errors).toEqual([]);
    });

    test("a genuine violation in a CODE file is still caught alongside an untouched non-code file in the same pass", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["notes.md", "eval is not allowed on any page.\n"],
          ["lib/bad.ts", 'import fs from "node:fs"\n'],
        ]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/bad.ts");
    });
  });

  describe("task-12 review round 2 — CODE_EXTENSIONS was missing `.mts`/`.cts`, and the match was case-sensitive", () => {
    test("a `.mts` file's own forbidden import is scanned, not silently skipped — round 1's CODE_EXTENSIONS omitted `.mts`/`.cts` even though Bun executes both as TypeScript", () => {
      // Reproduces the reviewer's finding exactly: before this fix, `isCodeFile` returned false
      // for `.mts`, so the scan loop's `if (!isCodeFile(from)) continue;` skipped this file's
      // text entirely — a `node:fs` import inside it would never be caught.
      const errors = scanTreeImports({
        files: new Map([["lib/mod.mts", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/mod.mts");
      expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    });

    test("a `.cts` file's own `require(...)` call is scanned, not silently skipped", () => {
      const errors = scanTreeImports({
        files: new Map([["lib/mod.cts", 'const fs = require("fs")\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/mod.cts");
      expect(errors[0]?.code).toBe("REQUIRE_CALL");
    });

    test("a `.cts` target `has` affirms but `files` never scanned is STILL fatal, matching `.ts`'s own treatment (the `effectiveHas` mirror of the scan-loop gap)", () => {
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/legacy.cts"\n']]),
        has: (relPath) => relPath === "lib/legacy.cts" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
    });

    test("a `.TS` file (uppercase extension) is scanned exactly like `.ts` — filesystems are case-insensitive, so the match must be too", () => {
      // Round 1's `isCodeFile` used `relPath.endsWith(extension)` against a lowercase-only
      // list, so `.endsWith(".ts")` on `"lib/mod.TS"` was false and this file's own forbidden
      // import was never scanned — a real bypass on Windows/macOS, where `lib/mod.TS` and
      // `lib/mod.ts` name the same file.
      const errors = scanTreeImports({
        files: new Map([["lib/mod.TS", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/mod.TS");
    });

    test("a `.TS` (uppercase) target `has` affirms but `files` never scanned is STILL fatal", () => {
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/legacy.TS"\n']]),
        has: (relPath) => relPath === "lib/legacy.TS" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
    });

    test("a file whose name merely CONTAINS a code extension as a substring (`notes.cts.bak`) is not treated as code — proves the match is on the real extension (`path.extname`), not a substring scan, so widening the set did not become `scan everything`", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["notes.cts.bak", "eval is mentioned here but this is not a code file.\n"],
        ]),
        has: () => true,
      });
      expect(errors).toEqual([]);
    });
  });

  test("scanModuleEdges returns only static import specifiers, runtime included", () => {
    expect(
      scanModuleEdges(
        'import { definePage } from "@termcraft/runtime"\nimport t from "../lib/theme"\n',
      ),
    ).toEqual(["@termcraft/runtime", "../lib/theme"]);
  });

  // --- adversarial coverage beyond the brief's own two samples (Your Job, step 3) ---

  test("a forbidden import in a shared module no entry file even mentions is still caught — every file in the tree is scanned, not only entry files", () => {
    const errors = scanTreeImports({
      files: new Map([
        [
          "pages/home.tsx",
          'import { definePage } from "@termcraft/runtime"\nexport const meta = definePage({})\n',
        ],
        // "lib/orphan.ts" is imported by nothing in this fixture — no closure walk starting
        // from any entry would ever reach it — yet the whole-tree scan must still reject its
        // own forbidden import; that is the entire point of scanning every file, not entries.
        ["lib/orphan.ts", 'import fs from "node:fs"\n'],
      ]),
      has: () => true,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/orphan.ts");
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a dynamic import() inside a shared module is fatal and attributed to that module, not to whatever imports it", () => {
    const errors = scanTreeImports({
      files: new Map([
        ["pages/home.tsx", 'import "../lib/loader"\n'],
        ["lib/loader.ts", 'const m = await import("../lib/theme")\nexport const x = m\n'],
        ["lib/theme.ts", "export const theme = 1\n"],
      ]),
      has: (relPath) => ["pages/home.tsx", "lib/loader.ts", "lib/theme.ts"].includes(relPath),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/loader.ts");
    expect(errors[0]?.code).toBe("DYNAMIC_IMPORT");
  });

  test("a re-export of the runtime inside a shared module is fatal and attributed to that module", () => {
    const errors = scanTreeImports({
      files: new Map([["lib/reexport.ts", 'export { atom } from "@termcraft/runtime"\n']]),
      has: () => true,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("lib/reexport.ts");
    expect(errors[0]?.code).toBe("REEXPORT");
  });

  test("a query string on an otherwise-resolving relative specifier is fatal", () => {
    const errors = scanTreeImports({
      files: new Map([["pages/home.tsx", 'import t from "../lib/theme.ts?raw"\n']]),
      has: (relPath) => relPath === "lib/theme.ts",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a specifier reaching a file present on real disk but absent from the tree's file list is rejected — `has` is authoritative, never the real filesystem", () => {
    const errors = scanTreeImports({
      files: new Map([["pages/home.tsx", 'import pkg from "../package.json"\n']]),
      has: () => false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
  });

  test("multiple files each contribute their own violation, none swallowed", () => {
    const errors = scanTreeImports({
      files: new Map([
        ["a.ts", 'import x from "react"\n'],
        ["b.ts", 'const y = require("fs")\n'],
      ]),
      has: () => false,
    });
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("a file with no import at all produces no edges and no violations", () => {
    expect(scanModuleEdges("export const x = 1\n")).toEqual([]);
    const errors = scanTreeImports({
      files: new Map([["lib/pure.ts", "export const x = 1\n"]]),
      has: () => true,
    });
    expect(errors).toEqual([]);
  });

  test("scanModuleEdges feeding resolveClosure through a two-file import cycle terminates instead of hanging", () => {
    const files = new Map([
      ["pages/a.tsx", 'import "../lib/b"\n'],
      ["lib/b.ts", 'import "../pages/a"\n'],
    ]);
    const has = (relPath: string) => files.has(relPath);
    const closure = resolveClosure({
      entry: "pages/a.tsx",
      has,
      edgesOf: (relPath) => scanModuleEdges(files.get(relPath) ?? ""),
    });
    expect(closure instanceof Error).toBe(false);
    if (closure instanceof Error) return;
    expect(closure.files).toEqual(["lib/b.ts", "pages/a.tsx"]);
  });
});

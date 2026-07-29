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

  describe("task-11 review, Important 2 — a `.ts`/`.tsx` resolution target absent from `files` can never launder an unscanned module", () => {
    test("a `has` that affirms a `.ts` path never present in `files` does not let a relative import resolve to it", () => {
      // The review's own reproduction, re-pinned against a `.ts` (not `.js`) target — see the
      // task-12 review of this file's contract, above `scanTreeImports`: only a `.ts`/`.tsx`
      // target is held to the "must also be a key in `files`" bar, because only that kind of
      // file could itself hide a further forbidden import this pass never read. `has` answers
      // true for "lib/legacy.ts" but `files` was never given its source — this pass never
      // actually scanned it. If `has` alone were trusted, the import below would resolve
      // cleanly and "lib/legacy.ts" would load into a page having never itself been scanned
      // for a forbidden import.
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

    test("a legitimate cross-file import of a NON-module tree file resolves cleanly even though this pass never scanned its text — the false-fatal the task-12 review closed", () => {
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

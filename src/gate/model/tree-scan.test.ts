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
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
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
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
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

    test("a `.cts` target `has` affirms but `files` never scanned is STILL fatal, matching `.ts`'s own treatment (the post-resolution mirror of the scan-loop gap)", () => {
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/legacy.cts"\n']]),
        has: (relPath) => relPath === "lib/legacy.cts" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
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
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
    });
  });

  describe("task-12 review round 3 — the name shapes `path.extname` mis-reads: a whole-name extension, and no extension at all", () => {
    test('a bare `.ts` dotfile (the WHOLE name is the extension) is scanned as code, not silently skipped — `path.extname(".ts")` returns `""` under Node/Bun\'s dotfile convention, which round 2\'s implementation trusted', () => {
      // Proven by execution against real Bun before choosing this fix, and re-proven on the
      // IMPORT path in round 4: `await import()` on a file literally named `.ts` executed its
      // body as TypeScript, identically to `mod.ts`. A path.extname-based predicate (round 2's
      // shape) returns "" for this name, so it was classified as non-code and its own forbidden
      // import was never scanned — a silent miss.
      const errors = scanTreeImports({
        files: new Map([[".ts", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe(".ts");
      expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    });

    test("a `.mjs` dotfile nested under a directory (`lib/.mjs`) is scanned as code, not silently skipped", () => {
      const errors = scanTreeImports({
        files: new Map([["lib/.mjs", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/.mjs");
      expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    });

    test("an UNSCANNED `.ts` dotfile target `has` affirms is STILL fatal — the post-resolution mirror of the dotfile scan-loop gap", () => {
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../.ts"\n']]),
        has: (relPath) => relPath === ".ts" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
    });

    test("a file with NO extension at all (`lib/README`) is scanned as code, not silently skipped — Bun executes an extensionless file as TypeScript on the IMPORT path too (round 4's measurement)", () => {
      const errors = scanTreeImports({
        files: new Map([["lib/README", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("lib/README");
      expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    });

    test("an UNSCANNED extensionless target `has` affirms is STILL fatal — the post-resolution mirror of the extensionless scan-loop gap", () => {
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import x from "../lib/README"\n']]),
        has: (relPath) => relPath === "lib/README" || relPath === "pages/home.tsx",
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
    });

    test('a genuinely non-code file (`.yaml`) still passes cleanly — the predicate never became "scan everything"', () => {
      const errors = scanTreeImports({
        files: new Map([["config.yaml", "note: do not eval this file, it is not code\n"]]),
        has: () => true,
      });
      expect(errors).toEqual([]);
    });

    test("a file whose real trailing extension is CODE despite an earlier substring that looks like data (`component.md.ts`) is scanned — proves the extension is matched against the real last extension, not a substring probe over the whole name", () => {
      // If a broken re-implementation probed substrings over the whole name instead of taking
      // the real trailing extension, "component.md.ts" contains ".md", so this file would be
      // wrongly classified as data and its own forbidden import silently missed — the
      // security-relevant direction.
      const errors = scanTreeImports({
        files: new Map([["component.md.ts", 'import fs from "node:fs"\n']]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("component.md.ts");
      expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    });

    test("a file whose real trailing extension is DATA despite an earlier substring that looks like code (`script.ts.md`) still passes cleanly — the mirror of the previous test", () => {
      const errors = scanTreeImports({
        files: new Map([["script.ts.md", "eval is mentioned here but this is prose, not code.\n"]]),
        has: () => true,
      });
      expect(errors).toEqual([]);
    });
  });

  describe("task-12 review round 4 — the predicate is DERIVED from what Bun's loader executes on the import path, and must equal it row for row", () => {
    // Every name in these two lists is a MEASURED fact, not a judgement about what "looks like
    // code": each was written to disk with a real side effect plus an export and `await
    // import()`ed by absolute path under Bun 1.3.14, exactly the way
    // `host/session/model/source-mount.ts` mounts a page. The left list executed its body; the
    // right list came back through a non-executing loader (`{ default: string }` from the
    // text/file loader, or a JSON/TOML parse error). Deliberately NOT measured with `bun run` —
    // the CLI entrypoint picks a loader differently from the module graph, and that
    // disagreement is what made round 3's list wrong in both directions at once.
    //
    // These two tests are the standing bar this task kept failing: the SAME source text, keyed
    // only on the file's name, must be scanned on the left and skipped on the right. Round 1
    // fails the left list (no `.mts`/`.cts`); round 3's denylist fails the right list (`.csv`,
    // `.sql`, `.avif`, `.scss`, `.mp4` and 20 more were absent from its 24 names, so all were
    // scanned and false-fatal'd).
    const EXECUTED_BY_BUN = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];
    const NOT_EXECUTED_BY_BUN = [
      ".json",
      ".md",
      ".markdown",
      ".txt",
      ".yml",
      ".yaml",
      ".toml",
      ".lock",
      ".css",
      ".html",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".ico",
      ".bmp",
      ".woff",
      ".woff2",
      ".ttf",
      ".otf",
      ".eot",
      ".map",
      ".avif",
      ".csv",
      ".tsv",
      ".sql",
      ".log",
      ".rst",
      ".adoc",
      ".tex",
      ".scss",
      ".less",
      ".styl",
      ".mdx",
      ".sh",
      ".py",
      ".ini",
      ".bak",
      ".wasm",
      ".pdf",
      ".mp4",
      ".tiff",
      ".patch",
      ".diff",
      ".xml",
      ".pem",
    ];
    const FORBIDDEN_SOURCE = 'import fs from "node:fs"\n';

    test("every extension Bun's loader EXECUTES has its own forbidden import scanned", () => {
      const scanned = EXECUTED_BY_BUN.filter(
        (extension) =>
          scanTreeImports({
            files: new Map([[`lib/mod${extension}`, FORBIDDEN_SOURCE]]),
            has: () => true,
          }).length === 1,
      );
      expect(scanned).toEqual(EXECUTED_BY_BUN);
    });

    test("every extension Bun's loader does NOT execute is skipped, even given byte-identical source text", () => {
      // The failure this closes is Critical 2 of round 3's re-review: one occurrence of a
      // banned word anywhere in any file outside a 24-item list was fatal, so `LICENSE`,
      // `CHANGELOG`, `.csv`, `.sql`, `.log`, `.tex` and random `.mp4`/`.pdf` bytes all
      // false-fatal'd. A file the loader never executes cannot carry a module edge at all.
      const wronglyScanned = NOT_EXECUTED_BY_BUN.filter(
        (extension) =>
          scanTreeImports({
            files: new Map([[`assets/mod${extension}`, FORBIDDEN_SOURCE]]),
            has: () => true,
          }).length !== 0,
      );
      expect(wronglyScanned).toEqual([]);
    });

    test("task-12 review round 3, Important 3 — an import of a real, present `.avif` asset resolves CLEANLY instead of being reported as a file that does not exist", () => {
      // Round 3 reported `UNRESOLVED_IMPORT` with the message `no file at "assets/logo.avif"`
      // for a file `has` affirms IS there — a false diagnosis about existence, and arbitrary:
      // `.webp` passed only because it happened to be one of the 24 names. `isTrustedTarget` is
      // now keyed on whether the loader would execute the target, and `.avif` measurably is not
      // executed, so it needs no scan to be trusted.
      const errors = scanTreeImports({
        files: new Map([["pages/home.tsx", 'import logo from "../assets/logo.avif"\n']]),
        has: (relPath) => relPath === "assets/logo.avif" || relPath === "pages/home.tsx",
      });
      expect(errors).toEqual([]);
    });

    test("a stylesheet's own `@import` is not a module edge — `.scss`/`.less`/`.styl` pass cleanly", () => {
      // Round 3 tokenized these as JS/TS, where `@import "colors";` lexes as a real import
      // statement and reported `FORBIDDEN_IMPORT` on an ordinary stylesheet.
      for (const relPath of ["theme.scss", "theme.less", "theme.styl"]) {
        expect(
          scanTreeImports({
            files: new Map([[relPath, '@import "colors";\n.a { color: red }\n']]),
            has: () => true,
          }),
        ).toEqual([]);
      }
    });

    test("a whole-name dotfile that is NOT a code extension (`.env`, `.gitignore`) is DATA — the dotfile shape alone never makes a file code", () => {
      // The mirror of the `.ts`/`lib/.mjs` tests above, and the discriminator against "treat
      // every dotfile as code": measured, `.ts` and `lib/.mjs` execute while `.env` and
      // `.gitignore` come back through the text loader without executing.
      for (const relPath of [".env", ".gitignore"]) {
        expect(
          scanTreeImports({
            files: new Map([[relPath, "# do not eval\nAPI=1\n"]]),
            has: () => true,
          }),
        ).toEqual([]);
      }
    });

    test("an EXTENSIONLESS file stays code — the fail-closed direction the measurement requires, even though it costs a false fatal on extensionless prose", () => {
      // Stated plainly because it is the residual this predicate consciously leaves: a
      // `LICENSE` or `CHANGELOG` with no extension really would execute if imported, so it is
      // scanned, and prose in it that spells a bare `eval` really is refused. The refusal is
      // loud and fixable (give the file an extension); a silent pass on a file the loader
      // executes is neither.
      const errors = scanTreeImports({
        files: new Map([["LICENSE", "Licensees may not eval the software.\n"]]),
        has: () => true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("task-12 review round 4, Critical 1 — an extensionless `Dockerfile` full of `#` comments TERMINATES through the real whole-tree scan", async () => {
      // The reachability half of the `jsx.ts` fix, pinned at THIS module's own perimeter rather
      // than at the reader's: `scanTreeImports` -> `scanImportAllowlist` ->
      // `computeJsxTextTokenIndices` -> `scanJsx`, and an extensionless file is code by this
      // module's measured predicate, so ordinary `#`-commented tree content reaches the reader.
      // Before the `jsx.ts` fix this call never returned — no timeout, no cancellation, no
      // error, and `runTreeImports` is synchronous, so it blocked the event loop outright.
      //
      // Runs OUT OF PROCESS on purpose: `bun test`'s per-test timeout is a timer on the very
      // event loop a synchronous spin blocks, so an in-process version of this test would wedge
      // the whole suite on a regression instead of failing it (measured — see the same note in
      // `jsx.test.ts`).
      const modulePath = `${import.meta.dir.replaceAll("\\", "/")}/tree-scan.ts`;
      const files = {
        Dockerfile: "# syntax=docker/dockerfile:1\nFROM node:22\n# install deps\nRUN bun i\n",
      };
      const script = [
        `const { scanTreeImports } = await import(${JSON.stringify(modulePath)});`,
        `const files = new Map(Object.entries(${JSON.stringify(files)}));`,
        `const errors = scanTreeImports({ files, has: () => true });`,
        `console.log(JSON.stringify({ count: errors.length }));`,
      ].join("\n");
      const proc = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);

      expect(stdout.trim()).toBe('{"count":0}');
      expect(proc.exitCode).toBe(0);
    }, 40_000);
  });

  describe("task-12b — the two defects in this perimeter that Task 14's wiring would have made live", () => {
    test("defect A — a deeply nested UNTERMINATED page body TERMINATES through the real whole-tree scan", async () => {
      // The reachability half of `jsx.ts`'s memo, pinned at THIS module's perimeter:
      // `scanTreeImports` -> `scanImportAllowlist` -> `computeJsxTextTokenIndices` -> `scanJsx`.
      // `"<a>{".repeat(k)` is what an agent leaves behind when it stops mid-page; it contains no
      // `#`, trips no `scannerStalled`, and yields ZERO errors, so every millisecond of it was
      // wasted work. Before the memo the cost doubled per nesting level — 96 chars took 12 971ms
      // through this same path — so the 256-char source below finishes in no budget at all and
      // this test fails (subprocess killed, no output, non-zero exit) if the memo is removed.
      // `runTreeImports` is SYNCHRONOUS and Task 14 calls it once per turn, so the pre-fix cost
      // was paid on the event loop with no timeout, no cancellation and no error.
      //
      // OUT OF PROCESS under an external kill, for the reason spelled out on the `Dockerfile`
      // test above: `bun test`'s own timeout cannot interrupt a synchronous spin.
      const modulePath = `${import.meta.dir.replaceAll("\\", "/")}/tree-scan.ts`;
      const files = { "pages/home.tsx": "<a>{".repeat(64) };
      const script = [
        `const { scanTreeImports } = await import(${JSON.stringify(modulePath)});`,
        `const files = new Map(Object.entries(${JSON.stringify(files)}));`,
        `const errors = scanTreeImports({ files, has: () => true });`,
        `console.log(JSON.stringify({ count: errors.length }));`,
      ].join("\n");
      const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);

      expect(stdout.trim()).toBe('{"count":0}');
      expect(proc.exitCode).toBe(0);
    }, 40_000);

    test("defect A residual — a page deep enough to exhaust the JS stack is REJECTED, never allowed to throw out of this synchronous scan", async () => {
      // Fix round 1's IMPORTANT 2. `./jsx`'s reader is recursive descent, so past a certain
      // nesting depth the ENGINE throws `RangeError: Maximum call stack size exceeded`. Measured
      // through this function: `"<a>{".repeat(k)` returns at 24 000 chars (3 774 ms, zero errors)
      // and threw at 32 000; well-formed nesting returned at 59 998 and threw at 99 996. Not a
      // regression — the pre-memo reader overflows at the same order of magnitude on well-formed
      // input — but `runTreeImports` is SYNCHRONOUS with no `try` of its own, so an escaping
      // throw crashes the turn Task 14 is about to wire instead of rejecting a page.
      //
      // OUT OF PROCESS under an external kill: the 24 000-char row alone costs seconds, and a
      // regression that restores the throw must fail this test rather than take the suite with
      // it. Both shapes are checked, and the well-formed 60 000-char row is the "still returns
      // normally" half — a fix that simply rejected everything large would fail on it.
      const modulePath = `${import.meta.dir.replaceAll("\\", "/")}/tree-scan.ts`;
      const script = [
        `const { scanTreeImports } = await import(${JSON.stringify(modulePath)});`,
        `const cases = {`,
        `  deepUnterminated: "<a>{".repeat(20000),`,
        `  deepWellFormed: "<a>".repeat(20000) + "x" + "</a>".repeat(20000),`,
        `  bigButShallow: "<a>".repeat(8000) + "x" + "</a>".repeat(8000),`,
        `};`,
        `const out = {};`,
        `for (const [name, source] of Object.entries(cases)) {`,
        `  const files = new Map([["pages/home.tsx", source]]);`,
        `  const errors = scanTreeImports({ files, has: () => true });`,
        `  out[name] = errors.map((e) => e.code);`,
        `}`,
        `console.log(JSON.stringify(out));`,
      ].join("\n");
      const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 60_000);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);

      // Exit 0 is the load-bearing assertion: a thrown RangeError leaves the process non-zero
      // with no JSON at all, which is exactly what happened before this conversion.
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        deepUnterminated: ["UNSCANNABLE_SOURCE"],
        deepWellFormed: ["UNSCANNABLE_SOURCE"],
        bigButShallow: [],
      });
    }, 90_000);

    // ---------------------------------------------------------------- defect B
    //
    // THE MEASURED LOADER ORDER these tests are judged against. `await import(<absolute path>)`
    // — what `host/session/model/source-mount.ts:137` does — under Bun 1.3.14, every fixture in
    // its OWN directory (Bun's module cache aliases paths across a case-insensitive filesystem
    // otherwise), the imported value exported onward so nothing can be elided. All 32 present-
    // subsets of the five candidate names x all five specifiers = 160 fixtures:
    //
    //   ../lib/foo        lib/foo > lib/foo.tsx > lib/foo.ts > lib/foo.js > lib/foo.json
    //   ../lib/foo.tsx    lib/foo.tsx
    //   ../lib/foo.ts     lib/foo.ts
    //   ../lib/foo.js     lib/foo.js > lib/foo.ts > lib/foo.tsx
    //   ../lib/foo.json   lib/foo.json
    //
    // `resolveDesignSpecifier`'s own order (exact, then `.tsx`, then `.ts`, and the probe only
    // for an extensionless specifier) is a strict PREFIX of each of those, which is the whole
    // soundness argument: where the design resolver resolves, it names the file Bun runs; where
    // it stops short it reports `UNRESOLVED_IMPORT`, which is fatal. The matrix test at the end
    // of this block replays that claim over all 1215 rows instead of trusting this paragraph.
    const BUN_ORDER = {
      "../lib/foo": ["lib/foo", "lib/foo.tsx", "lib/foo.ts", "lib/foo.js", "lib/foo.json"],
      "../lib/foo.tsx": ["lib/foo.tsx"],
      "../lib/foo.ts": ["lib/foo.ts"],
      "../lib/foo.js": ["lib/foo.js", "lib/foo.ts", "lib/foo.tsx"],
      "../lib/foo.json": ["lib/foo.json"],
    } as const;

    test("an UNSCANNED extensionless target is not laundered by a scanned `.tsx` SIBLING — the file Bun would load is the one that must have been scanned", () => {
      // Round 0's bypass, verbatim: these exact inputs returned `[]` at HEAD. The predicate
      // answered `false` for "lib/foo" (present, executed, never scanned), the resolver read that
      // as "no such file" and probed on, and "lib/foo.tsx" — a DIFFERENT file, scanned —
      // satisfied the import. Bun loads and executes "lib/foo", whose text this pass never read.
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
    });

    test("an UNSCANNED `lib/foo.tsx` is not laundered by a scanned `lib/foo.ts` either — the same bypass one probe step further down", () => {
      // Fix round 1's CRITICAL. Round 0 latched on the EXACT path, so this row — where the exact
      // path does not exist at all and the FIRST PROBE CANDIDATE is the unscanned one — was still
      // clean after it. Measured: `import "./lib/foo"` with both `.tsx` and `.ts` present
      // executes `lib/foo.tsx`, the unscanned one. This is the row that retired the latch: any
      // candidate the resolver can advance past is another row of the same bug, and there is no
      // bound on how many latches that would take.
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo.ts", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo.tsx", "lib/foo.ts"].includes(relPath),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("pages/home.tsx");
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
    });

    test("its SAFE mirror — an unscanned `lib/foo.ts` behind a scanned `lib/foo.tsx` — still resolves cleanly", () => {
      // The pair is what proves the predicate DISCRIMINATES rather than just rejecting more: the
      // two trees differ only in which sibling holds the source, and Bun loads `lib/foo.tsx` in
      // both. Here that file was scanned, so clean is the correct answer and the unscanned
      // `lib/foo.ts` is simply never loaded through this specifier.
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo.ts", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toEqual([]);
    });

    test("the refusal names the file that was not scanned, and never claims the tree lacks it", () => {
      // Fix round 1's IMPORTANT 3. Every refusal of this kind used to carry
      // `resolveDesignSpecifier`'s own `no file at "lib/foo" (probed .tsx, .ts; …)` — false about
      // a tree the author can see holds `lib/foo` AND `lib/foo.tsx`, and unactionable. The
      // resolution is not what failed, so the message must not say it was.
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors[0]?.message).toContain('resolves to "lib/foo"');
      expect(errors[0]?.message).toContain("never given the source of");
      expect(errors[0]?.message).not.toContain("no file at");
      expect(errors[0]?.specifier).toBe("../lib/foo");
    });

    test("the same tree with `lib/foo` ALSO scanned resolves cleanly — the fix is an intersection, not a ban on trees that hold both names", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo", "export const x = 1\n"],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toEqual([]);
    });

    test("an EXPLICIT `./foo.tsx` import resolves cleanly next to an unscanned `lib/foo` — the question is asked about the RESOLVED file, not about every name that looks like a candidate", () => {
      // The false-diagnosis direction. Asked as a predicate over NAMES, `lib/foo.tsx` is
      // indistinguishable between "probe candidate for `./foo`, which Bun would NOT load" and
      // "exact target of `./foo.tsx`, which Bun WILL load" — and a stateless rule that refused
      // both produced a fatal on this valid input (executed in round 0's own revert experiments).
      // Asked AFTER resolution the ambiguity does not arise: the resolver already chose.
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo.tsx"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toEqual([]);
    });

    test("both specifiers in ONE file: `./foo` is fatal and the very next `./foo.tsx` is not", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import a from "../lib/foo"\nimport b from "../lib/foo.tsx"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
      expect(errors[0]?.line).toBe(1);
    });

    test("an unrelated import right after a refused one is judged on its own merits", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import a from "../lib/foo"\nimport b from "../lib/bar.tsx"\n'],
          ["lib/bar.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo", "lib/bar.tsx"].includes(relPath),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("UNSCANNED_IMPORT");
      expect(errors[0]?.line).toBe(1);
    });

    test("a NON-code target never needs a scan — an unscanned `lib/foo.json` behind a scanned `lib/foo.tsx` changes nothing", () => {
      const errors = scanTreeImports({
        files: new Map([
          ["pages/home.tsx", 'import x from "../lib/foo"\n'],
          ["lib/foo.tsx", "export const x = 1\n"],
        ]),
        has: (relPath) => ["pages/home.tsx", "lib/foo.json", "lib/foo.tsx"].includes(relPath),
      });
      expect(errors).toEqual([]);
    });

    test("SOUNDNESS MATRIX — all 1215 (present x scanned x specifier) rows: no row where the Gate is clean while Bun executes a file this pass never read", () => {
      // The exhaustive form of every hand-written row above, and the reason fix round 1 replaced
      // a latch with a post-resolution question rather than adding a second latch: a fix is only
      // finished when this count is zero, and hand-picked rows cannot show that.
      //
      // Five candidate names x three states (absent / present-but-unscanned / present-and-
      // scanned) = 243 trees, x five specifiers = 1215 rows. `bunLoads` comes from the measured
      // table at the top of this block, never from `resolveDesignSpecifier` — checking the
      // resolver against itself would prove nothing.
      const CANDIDATES = ["lib/foo", "lib/foo.tsx", "lib/foo.ts", "lib/foo.js", "lib/foo.json"];
      const CODE = new Set(["lib/foo", "lib/foo.tsx", "lib/foo.ts", "lib/foo.js"]);
      const SPECIFIERS = Object.keys(BUN_ORDER) as (keyof typeof BUN_ORDER)[];
      // `resolveDesignSpecifier`'s own order (design §6): the exact path, then — only for an
      // extensionless specifier — `.tsx` then `.ts`. Nothing else, and no directory index.
      const DESIGN_ORDER: Record<string, readonly string[]> = {
        "../lib/foo": ["lib/foo", "lib/foo.tsx", "lib/foo.ts"],
        "../lib/foo.tsx": ["lib/foo.tsx"],
        "../lib/foo.ts": ["lib/foo.ts"],
        "../lib/foo.js": ["lib/foo.js"],
        "../lib/foo.json": ["lib/foo.json"],
      };

      const unsound: string[] = [];
      const falseFatal: string[] = [];
      const lemmaBroken: string[] = [];
      let rows = 0;

      for (let code = 0; code < 3 ** CANDIDATES.length; code += 1) {
        const state = CANDIDATES.map((_, i) => Math.floor(code / 3 ** i) % 3);
        const present = CANDIDATES.filter((_, i) => state[i] !== 0);
        const scanned = CANDIDATES.filter((_, i) => state[i] === 2);
        for (const specifier of SPECIFIERS) {
          rows += 1;
          const files = new Map<string, string>([
            ["pages/home.tsx", `import x from "${specifier}"\n`],
          ]);
          for (const name of scanned) files.set(name, "export const x = 1\n");
          const errors = scanTreeImports({
            files,
            has: (relPath) => relPath === "pages/home.tsx" || present.includes(relPath),
          });
          const bunLoads = BUN_ORDER[specifier].find((name) => present.includes(name)) ?? null;
          const designPick = DESIGN_ORDER[specifier]!.find((n) => present.includes(n)) ?? null;
          const label = `${specifier} present=[${present.join(",")}] scanned=[${scanned.join(",")}]`;

          // The soundness lemma the whole design rests on: whenever the design resolver resolves
          // at all, it names exactly the file Bun runs.
          if (designPick !== null && designPick !== bunLoads) lemmaBroken.push(label);

          const loadIsUnread =
            bunLoads !== null && CODE.has(bunLoads) && !scanned.includes(bunLoads);
          if (errors.length === 0 && loadIsUnread) unsound.push(label);
          // A refusal THIS TASK introduced (`UNSCANNED_IMPORT`) on a row whose actual load is
          // safe would be a false fatal. Rows the design's own §6 rules refuse — an extensionless
          // specifier Bun would serve from `.js`/`.json`, say — are NOT counted here: refusing
          // those is the design speaking, not this predicate.
          if (errors.some((e) => e.code === "UNSCANNED_IMPORT") && !loadIsUnread)
            falseFatal.push(label);
        }
      }

      expect(rows).toBe(1215);
      expect(lemmaBroken).toEqual([]);
      expect(unsound).toEqual([]);
      expect(falseFatal).toEqual([]);
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

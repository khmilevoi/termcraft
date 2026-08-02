import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { UUIDv7 } from "core/protocol";
import { type TurnValidationDeps, runTurnValidation } from "core/turns";

import { buildGateRunner } from "./create-shell";

/**
 * THE IMPORT PERIMETER'S WIRING, PROVEN AT THE TURN LEVEL (red-debt.md's SECURITY-CRITICAL
 * must-wire;
 * task-14-supplement §1).
 *
 * `GateRunner.runTreeImports` — the whole-tree import allowlist and, inside it, design §5.8's
 * `eval`/`new Function` ban — had NO production caller before task 14. Task 14 wires it into
 * `core/turns/model/validation.ts`. Every test below drives the REAL `gate` adapter
 * (`buildGateRunner`, the exact factory `createShell` hands the Kernel) through the REAL
 * `runTurnValidation`, so nothing in the security path is a fake.
 *
 * WHY THIS FILE LIVES IN `entrypoint` AND NOT IN `core/turns`. `core` may not import `gate`
 * (module DAG, `docs/architecture/code-structure.md` §11) — checked, not assumed: `grep -rln
 * 'from "gate' src/core/` finds nothing, test files included. `entrypoint` is the composition
 * root and already imports both (`create-shell.ts`, `smoke.test.ts`), so it is the one layer
 * where "the shipped pipeline rejects this" can be asserted without a fake standing in for the
 * scanner. `core/turns/model/validation.test.ts` proves the complementary half against the port
 * fake — that the whole-tree call happens at all, with the whole tree, and that its errors are
 * fatal to the turn.
 *
 * EVERY VIOLATION HERE SITS IN A SHARED MODULE NO PAGE NAMES DIRECTLY:
 * `pages/home.tsx` -> the shared module -> the violation. That is the shape `runPage`
 * structurally cannot catch (it only ever sees one entry's own source), and it is the shape the
 * supplement requires proof for.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT. These rows prove the CALLER exists, runs once
 * per turn in the right order, and makes each tested violation fatal to the turn — plus, since
 * task 14b, that the differential-parse shapes reach it: a `.ts` module whose "JSX" is fiction
 * and a `.tsx` module whose prose holds every code-mode trap both report their violations here.
 *
 * Source-coverage completeness itself is `gate/model/lexer.ts`'s concern, and it is measured
 * against Bun's own parse by `gate/model/lexer.oracle.test.ts` rather than by this file. The
 * residual that remains open is design §5.8's dynamic-code ban (`import-scan.ts`'s KNOWN GAPS
 * 1-4), registered in the plan's red-debt ledger.
 */

const TURN_ID = "0192f6f0-0000-7000-8000-0000000014aa" as UUIDv7;

/** A page whose own source is clean and whose `meta` satisfies the page contract. */
const CLEAN_PAGE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
import { accent } from "../lib/theme"
export const meta = definePage({
  title: "Home",
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
  kitApiVersion: 1,
})
export default reatomComponent(() => <Panel><Text>{accent}</Text></Panel>)
`;

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  pages: [{ slug: "home", entry: "pages/home.tsx" }],
});

function machineAtValidating(): StateMachine<TurnState, TurnAction> {
  const m = reatomTurnStateMachine();
  m.apply("beginAdmission");
  m.apply("finishAdmission");
  m.apply("beginAttempt");
  m.apply("beginStopping");
  m.apply("beginSnapshot");
  m.apply("candidateCaptured");
  return m;
}

/**
 * The REAL gate adapter, with only the smoke renderer stubbed. `tscExePath` is omitted the same
 * way `gate/adapters/gate-runner.test.ts` omits it — the type-check stage is not what these
 * tests are about, and spawning a compiler per case would make them minutes long. The import
 * scan and the manifest slice are the real thing either way.
 */
function realTurnValidationDeps(): {
  readonly deps: TurnValidationDeps;
  readonly machine: StateMachine<TurnState, TurnAction>;
} {
  const machine = machineAtValidating();
  const deps: TurnValidationDeps = {
    machine,
    gateRunner: buildGateRunner("", { render: async () => ({ ok: true }) }),
    publish: () => {},
  };
  return { deps, machine };
}

/** Runs one whole turn validation over a tree given as `tree-relative path -> source text`. */
async function validateTree(
  files: ReadonlyMap<string, string>,
): Promise<readonly { readonly code: string; readonly file: string | null }[]> {
  const { deps } = realTurnValidationDeps();
  const result = await wrap(
    runTurnValidation(deps, {
      turnId: TURN_ID,
      attempt: 1,
      manifestText: files.get("pages.json") ?? MANIFEST,
      treePaths: [...files.keys()],
      treeInventory: [...files.keys()].map((relPath, index) => ({
        relPath,
        sha256: String(index).padStart(64, "0"),
      })),
      files,
      designRoot: "/nonexistent-candidate/design",
    }),
  );
  if (result.kind === "passed") return [];
  return result.diagnostics.errors.map((error) => ({ code: error.code, file: error.file }));
}

/** `pages/home.tsx` -> `lib/theme.ts` -> whatever `themeBody` does. */
function sharedModuleTree(themeBody: string): ReadonlyMap<string, string> {
  return new Map([
    ["pages.json", MANIFEST],
    ["pages/home.tsx", CLEAN_PAGE],
    ["lib/theme.ts", themeBody],
  ]);
}

describe("the turn's import perimeter, through the real gate adapter", () => {
  test("a CLEAN shared module still passes the whole-tree scan — the guard does not over-fire", async () => {
    // The valid-input companion every tightened guard on this branch is required to carry:
    // without it, "everything is rejected" would satisfy each rejection test below.
    await context.start(async () => {
      const errors = await validateTree(sharedModuleTree(`export const accent = "#7ad7ff"\n`));
      // Excluded by CODE, not by "some error": `TYPE_CHECK_UNAVAILABLE` is the one stage this
      // harness deliberately does not provision (no `tscExePath` — spawning a compiler per
      // case would make this file minutes long). The import scan, which is what this row
      // asserts stays silent on clean input, contributes nothing.
      expect(errors.map((e) => e.code)).toEqual(["TYPE_CHECK_UNAVAILABLE"]);
    });
  });

  test.each([
    [
      "a forbidden bare import",
      `import x from "lodash"\nexport const accent = x\n`,
      "FORBIDDEN_IMPORT",
    ],
    [
      "a node: builtin import",
      `import fs from "node:fs"\nexport const accent = fs\n`,
      "FORBIDDEN_IMPORT",
    ],
    ["require()", `const fs = require("fs")\nexport const accent = fs\n`, "REQUIRE_CALL"],
    ["a dynamic import()", `export const accent = import("lodash")\n`, "DYNAMIC_IMPORT"],
    ["eval", `export const accent = eval("1+1")\n`, "EVAL_CALL"],
    ["new Function", `export const accent = new Function("return 1")\n`, "FUNCTION_CALL"],
    ["a re-export edge", `export * from "lodash"\nexport const accent = 1\n`, "REEXPORT"],
  ])(
    "%s in lib/theme.ts — a module NO page names directly — fails the turn with %#",
    async (_label, themeBody, expectedCode) => {
      await context.start(async () => {
        const errors = await validateTree(sharedModuleTree(themeBody));
        // The verdict is WHOLE-TREE: any error at all rejects the turn (see
        // `runTurnValidation`'s own doc). Asserting the CODE, not merely "some error",
        // so the test says which rule fired.
        expect(errors.map((e) => e.code)).toContain(expectedCode);
        const offending = errors.find((e) => e.code === expectedCode);
        expect(offending?.file).toBe("lib/theme.ts");
      });
    },
  );

  test("task 14b: a JSX-TEXT trap no longer hides a shared module's forbidden import from the TURN", async () => {
    // THE DIFFERENTIAL-PARSE CLASS, at the level where it mattered. Bun parses a `.tsx` file
    // with a JSX parser, so `it's`, `a /* b`, `see // here` and a backtick in children are
    // PROSE. The gate lexed them as code, where each opens a string, a comment running to end
    // of file, or a template literal — and swallows the real code that follows.
    //
    // MEASURED at task 14b's base commit, through THIS harness: every row below reported
    // *** NO VIOLATIONS *** while `Bun.Transpiler` transpiled the module and `await import()`
    // executed it. For a SHARED module the whole-tree scan is the only check there is, so each
    // was a total bypass. The assertion is on the CODE, because "the turn was rejected" would
    // also pass if the page failed its contract for an unrelated reason.
    const traps: readonly (readonly [string, string])[] = [
      ["an unterminated /* in JSX text", "a /* b"],
      ["an apostrophe in JSX text", "it's"],
      ["// in JSX text", "see // here"],
      ["a backtick in JSX text", "`tick"],
      ["U+FFFD in JSX text", "\uFFFD"],
      ["a hex colour in JSX text", "#7ad7ff"],
    ];
    await context.start(async () => {
      for (const [label, trap] of traps) {
        // THE MODULE IS `.tsx`, DELIBERATELY (task-14 review round 2, M3): a JSX body in a
        // `lib/theme.ts` is REJECTED by `Bun.Transpiler({loader:"ts"})`, so a `.ts` fixture
        // would pin a form the runtime never executes — the entire basis for calling this a
        // bypass. The extensionless specifier `../lib/theme` still resolves to `lib/theme.tsx`
        // (`foo > foo.tsx > foo.ts`, the measured order in `tree-scan.ts`).
        const exploit = `export const Glyph = () => <Text>${trap}</Text>\nimport fs from "node:fs"\nexport const e = eval("1")\n`;
        expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(exploit)).not.toThrow();
        const errors = await validateTree(
          new Map([
            ["pages.json", MANIFEST],
            ["pages/home.tsx", CLEAN_PAGE],
            ["lib/theme.tsx", exploit],
          ]),
        );
        const codes = errors.map((e) => e.code);
        expect([label, codes.includes("FORBIDDEN_IMPORT")]).toEqual([label, true]);
        expect([label, codes.includes("EVAL_CALL")]).toEqual([label, true]);
        // …and NOT by refusing the file: the prose is prose, so the module is genuinely scanned.
        expect([label, codes.includes("UNSCANNABLE_SOURCE")]).toEqual([label, false]);
      }
    });
  }, 30_000);

  test("task 14b fix round 1: a `.ts` shared module whose JSX is FICTION is still fully scanned", async () => {
    // CRITICAL 1. Bun parses no JSX at all in a `.ts` file, so a `<T>` type-parameter list plus a
    // `</T>` written in a later comment is not an element to anyone but a JSX reader. The
    // previous commit asked that reader unconditionally and SKIPPED whatever it called text, so
    // everything between them left the token stream: measured through THIS harness, the module
    // reported nothing at all while `Bun.Transpiler` accepted it and `await import()` executed
    // the payload. `tokenize` now takes the syntax from `tree-scan.ts`'s measured `parsesJsx`.
    const payload = `eval("1");\nimport fs from "node:fs";\nconst r = require("child_process");\nconst f = new Function("return 1");\n`;
    const shapes: readonly (readonly [string, string])[] = [
      ["a `<T>` type annotation", `let a: <T>(x: T) => T;\n${payload}// </T>\n`],
      ["a closing tag inside a string", `const s = "</T>";\nlet a: <T>(x: T) => T;\n${payload}`],
      ["an object-type method", `type O = { m: <T>(x: T) => T };\n${payload}// </T>\n`],
    ];
    await context.start(async () => {
      for (const [label, body] of shapes) {
        expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(body)).not.toThrow();
        const errors = await validateTree(
          new Map([
            ["pages.json", MANIFEST],
            ["pages/home.tsx", CLEAN_PAGE],
            ["lib/theme.ts", body],
          ]),
        );
        const codes = errors.map((e) => e.code);
        for (const code of ["FORBIDDEN_IMPORT", "REQUIRE_CALL", "EVAL_CALL", "FUNCTION_CALL"]) {
          expect([label, code, codes.includes(code)]).toEqual([label, code, true]);
        }
      }
    });
  }, 30_000);

  test("a legal Windows path in a prop is NOT refused — the round-1 over-fire is gone", async () => {
    // The valid-input companion the ruling requires for every tightened guard, and a real
    // regression the previous commit shipped: `<Text a="C:\Users\">hi</Text>` is legal,
    // Bun-accepted source that a terminal product can plausibly produce, and it rejected the
    // whole tree. Windowed lexing bounds the attribute string at the prose boundary instead.
    await context.start(async () => {
      const page = `export const Glyph = () => <Text a="C:\\Users\\">hi</Text>\nexport const accent = "#7ad7ff"\n`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(page)).not.toThrow();
      const errors = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.tsx", page],
        ]),
      );
      expect(errors.map((e) => e.code)).not.toContain("UNSCANNABLE_SOURCE");
      // …and the same module with a forbidden import still fails, so this is no blanket pass.
      const bad = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.tsx", `${page}import fs from "node:fs"\n`],
        ]),
      );
      expect(bad.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
    });
  });

  test("a U+FFFD at a CODE token position no longer HIDES anything — every violation is reported", async () => {
    // Round 1's Critical was that the scanner answers `NonTextFileMarkerTrivia` here, spanning to
    // end of file, so the import and the `eval` after it left the token stream. Round 1 answered
    // with a refusal; task 14b fix round 1 answers by RE-LEXING one character on, which reports
    // the violations instead of only admitting the file was unreadable — and which removed the
    // last measured over-fire, where the marker sat inside what Bun reads as a comment and a
    // legal page was rejected for it.
    //
    // Bun refuses THIS source outright, so it never reaches the runtime either way; what this
    // row pins is that the gate now SEES what the file holds.
    await context.start(async () => {
      const exploit = `export const accent = �
import fs from "node:fs"
export const e = eval("1")
`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(exploit)).toThrow();
      const errors = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.tsx", exploit],
        ]),
      );
      expect(errors.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
      expect(errors.map((e) => e.code)).toContain("EVAL_CALL");
      expect(errors.find((e) => e.code === "FORBIDDEN_IMPORT")?.file).toBe("lib/theme.tsx");

      const control = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.tsx", exploit.replace("\uFFFD", "1")],
        ]),
      );
      expect(control.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
      expect(control.map((e) => e.code)).toContain("EVAL_CALL");
    });
  });

  test("a HEX COLOUR in JSX text no longer hides what follows it — the violation is still caught", async () => {
    // The second truncation, found while proving C1's fix does not over-fire: `#` in JSX text
    // spun the scanner at zero width and the old loop silently returned the partial stream.
    // This project's whole palette is hex colours, so this shape is far likelier in a real
    // design page than U+FFFD. It must be SCANNED, not refused — asserting the forbidden
    // import is reported proves the stream reached past the `#`.
    await context.start(async () => {
      const errors = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          [
            "lib/theme.ts",
            `export const Swatch = () => <span>#7ad7ff</span>\nimport fs from "node:fs"\nexport const accent = fs\n`,
          ],
        ]),
      );
      expect(errors.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
      expect(errors.map((e) => e.code)).not.toContain("UNSCANNABLE_SOURCE");
    });
  });

  test("a clean page rendering a hex colour still PASSES — the truncation fix did not become a refusal", async () => {
    // The valid-input companion to the row above. Without it, "refuse anything containing `#`"
    // would satisfy that test, and every design page showing a palette swatch would break.
    await context.start(async () => {
      const errors = await validateTree(
        sharedModuleTree(`export const accent = "#7ad7ff"\nexport const label = "#1 pick"\n`),
      );
      expect(errors.map((e) => e.code)).toEqual(["TYPE_CHECK_UNAVAILABLE"]);
    });
  });

  test("the same forbidden import in a module NO page reaches at all is still fatal — the scan is whole-tree, not closure-scoped", async () => {
    await context.start(async () => {
      const errors = await validateTree(
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.ts", `export const accent = "#7ad7ff"\n`],
          ["lib/orphan.ts", `import fs from "node:fs"\nexport const x = fs\n`],
        ]),
      );
      expect(errors.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
      expect(errors.find((e) => e.code === "FORBIDDEN_IMPORT")?.file).toBe("lib/orphan.ts");
    });
  });

  test.each([
    ["extensionless", "screens/landing/main"],
    [".jsx", "screens/landing/main.jsx"],
  ])(
    "an %s entry survives the whole pipeline — the closure resolves and its shared module is still scanned",
    async (_label, entry) => {
      // Task-14-supplement §2: `entryPathSchema` permits both, and `tree-scan.ts`'s MEASURED
      // `isCodeFile` calls both code (Bun executes an extensionless file as TypeScript, and
      // `.jsx` is in the executed-extension set). If the caller's `files` map were narrowed by
      // a second, `core`-side "is this code" predicate, either of these would arrive
      // unscanned — and its own violation would vanish.
      await context.start(async () => {
        const errors = await validateTree(
          new Map([
            ["pages.json", JSON.stringify({ schemaVersion: 1, pages: [{ slug: "home", entry }] })],
            [entry, CLEAN_PAGE.replace("../lib/theme", "../../lib/theme")],
            ["lib/theme.ts", `import fs from "node:fs"\nexport const accent = fs\n`],
          ]),
        );
        expect(errors.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
        expect(errors.find((e) => e.code === "FORBIDDEN_IMPORT")?.file).toBe("lib/theme.ts");
      });
    },
  );

  test("an ENTRY that is not derivable from its slug resolves, and its own violation is caught", async () => {
    // `design/pages.json` binds identity to an arbitrary tree path; a fixture whose entry is
    // `pages/<slug>.tsx` proves nothing about manifest lookup.
    await context.start(async () => {
      const errors = await validateTree(
        new Map([
          [
            "pages.json",
            JSON.stringify({
              schemaVersion: 1,
              pages: [{ slug: "home", entry: "screens/landing/main.tsx" }],
            }),
          ],
          ["screens/landing/main.tsx", CLEAN_PAGE.replace("../lib/theme", "../../lib/theme")],
          ["lib/theme.ts", `import fs from "node:fs"\nexport const accent = fs\n`],
        ]),
      );
      expect(errors.map((e) => e.code)).toContain("FORBIDDEN_IMPORT");
      expect(errors.find((e) => e.code === "FORBIDDEN_IMPORT")?.file).toBe("lib/theme.ts");
    });
  });
});

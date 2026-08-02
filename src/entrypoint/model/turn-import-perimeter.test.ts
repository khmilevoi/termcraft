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
 * WHAT THIS FILE DOES NOT PROVE (task-14 review round 2): that the scan SEES the whole of every
 * file. These rows prove the CALLER exists, runs once per turn in the right order, and makes
 * each tested violation fatal to the turn. Source-coverage completeness is `gate/model/lexer.ts`'s
 * concern and is still OPEN there — an unterminated block comment opened in JSX text truncates
 * the token stream with no signal at all, and Bun executes such a file. A separate task owns
 * that. "The perimeter is wired and proven for these forms" is the whole claim here.
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

  test("C1: a U+FFFD that truncates the scan fails the TURN — it can never read as a clean tree", async () => {
    // THE CRITICAL (task-14 review round 1). `TextDecoder` produces U+FFFD for any invalid
    // UTF-8 byte, and turn staging decodes every tree file through it unfiltered. At a token
    // position it made the scanner return `NonTextFileMarkerTrivia` spanning to EOF, so
    // everything after it left the token stream — measured through this very harness: zero
    // violations reported for a shared module carrying a forbidden import, `eval`, `require`
    // AND `new Function`, all four of which the same file without the U+FFFD reports. Bun
    // executes such a module (verified by `await import()`). For a shared module the whole-tree
    // scan is the only check there is, so it was a total bypass.
    //
    // Fails CLOSED now, and the assertion is on the CODE: a bare "the turn was rejected" would
    // also pass if the page merely failed its contract for some unrelated reason.
    await context.start(async () => {
      // The U+FFFD must sit at a TOKEN position — in JSX text here, exactly as the executed
      // exploit had it. Inside a string literal or a comment the scanner lexes straight past
      // it and the violations below ARE reported; that case is the sibling assertion.
      //
      // THE MODULE IS `.tsx`, DELIBERATELY (task-14 review round 2, M3). Round 1 put this JSX
      // source in `lib/theme.ts`, and `Bun.Transpiler({loader:"ts"})` REJECTS that
      // (`Unexpected ï`) — so the fixture pinned a form the runtime would never have executed,
      // which is the entire basis for calling the truncation a bypass. `.tsx` transpiles, so
      // this fixture is the executable one. The extensionless specifier `../lib/theme` still
      // resolves to it (`foo > foo.tsx > foo.ts`, the measured order in `tree-scan.ts`).
      const exploit = `export const Glyph = () => <Text>�</Text>\nimport fs from "node:fs"\nexport const e = eval("1")\n`;
      const tree = (theme: string): ReadonlyMap<string, string> =>
        new Map([
          ["pages.json", MANIFEST],
          ["pages/home.tsx", CLEAN_PAGE],
          ["lib/theme.tsx", theme],
        ]);
      const errors = await validateTree(tree(exploit));
      expect(errors.map((e) => e.code)).toContain("UNSCANNABLE_SOURCE");
      expect(errors.find((e) => e.code === "UNSCANNABLE_SOURCE")?.file).toBe("lib/theme.tsx");

      // THE BEFORE/AFTER, in one test: the identical file with the marker replaced by an
      // ordinary character reports every violation the truncated one hid. Without this, a
      // guard that refused the tree for any reason at all would satisfy the assertion above.
      const control = await validateTree(tree(exploit.replace("�", "x")));
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

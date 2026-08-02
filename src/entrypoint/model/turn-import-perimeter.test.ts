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
 * THE IMPORT PERIMETER, PROVEN AT THE TURN LEVEL (red-debt.md's SECURITY-CRITICAL must-wire;
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
 * `pages/home.tsx` -> `lib/theme.ts` -> the violation. That is the shape `runPage` structurally
 * cannot catch (it only ever sees one entry's own source), and it is the shape the supplement
 * requires proof for.
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

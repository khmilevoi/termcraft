import { describe, expect, test } from "bun:test";

import type { TurnAttempt } from "core/machines";

import {
  StaleGateDiagnosticsError,
  type TurnGateDiagnosticsV1,
  type TurnGateFoldInputV1,
  appendPromptFold,
  foldGateDiagnosticsIntoPrompt,
} from "./prompt";

/**
 * `foldGateDiagnosticsIntoPrompt`/`appendPromptFold` are pure functions — no ports, no
 * Reatom, no clock. Tests exercise them directly, no fakes or `context.start` needed.
 */

function diagnostics(overrides: Partial<TurnGateDiagnosticsV1> = {}): TurnGateDiagnosticsV1 {
  return { errors: [], warnings: [], ...overrides };
}

function foldInput(overrides: Partial<TurnGateFoldInputV1> = {}): TurnGateFoldInputV1 {
  return {
    rejectedAttempt: 1 as TurnAttempt,
    nextAttempt: 2 as TurnAttempt,
    diagnostics: diagnostics(),
    ...overrides,
  };
}

describe("foldGateDiagnosticsIntoPrompt — the diagnostics freshness barrier", () => {
  test("nextAttempt === rejectedAttempt + 1 is fresh and folds", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        rejectedAttempt: 1 as TurnAttempt,
        nextAttempt: 2 as TurnAttempt,
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS2322",
              message: "boom",
              file: null,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(typeof result).toBe("string");
  });

  test("nextAttempt === rejectedAttempt (no advance) is stale", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({ rejectedAttempt: 2 as TurnAttempt, nextAttempt: 2 as TurnAttempt }),
    );
    expect(result).toBeInstanceOf(StaleGateDiagnosticsError);
  });

  test("nextAttempt skipping ahead (rejectedAttempt + 2) is stale", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({ rejectedAttempt: 1 as TurnAttempt, nextAttempt: 3 as TurnAttempt }),
    );
    expect(result).toBeInstanceOf(StaleGateDiagnosticsError);
  });

  test("nextAttempt going backward is stale", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({ rejectedAttempt: 3 as TurnAttempt, nextAttempt: 2 as TurnAttempt }),
    );
    expect(result).toBeInstanceOf(StaleGateDiagnosticsError);
  });

  test("stale error carries both attempt numbers", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({ rejectedAttempt: 1 as TurnAttempt, nextAttempt: 4 as TurnAttempt }),
    );
    if (!(result instanceof StaleGateDiagnosticsError))
      throw new Error("expected a StaleGateDiagnosticsError");
    expect(result.rejectedAttempt).toBe(1);
    expect(result.nextAttempt).toBe(4);
  });
});

describe("foldGateDiagnosticsIntoPrompt — folding errors and determinism warnings", () => {
  test("errors are rendered under a header, one line per error", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS2322",
              message: "Type 'string' is not assignable to 'number'.",
              file: "pages/home.tsx",
              line: 12,
              column: 4,
              blockedPages: null,
            },
            {
              kind: "import",
              code: "IMPORT_NOT_ALLOWED",
              message: "disallowed import",
              file: null,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("Type 'string' is not assignable to 'number'.");
    expect(result).toContain("pages/home.tsx");
    expect(result).toContain("12");
    expect(result).toContain("disallowed import");
  });

  test("determinism warnings (unguarded-timer, unguarded-randomness) ARE folded in", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS2322",
              message: "boom",
              file: null,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
          warnings: [
            {
              kind: "unguarded-timer",
              message: "setTimeout without a seeded clock",
              line: 5,
              column: null,
              file: null,
            },
            {
              kind: "unguarded-randomness",
              message: "Math.random without a seed",
              line: null,
              column: null,
              file: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("setTimeout without a seeded clock");
    expect(result).toContain("Math.random without a seed");
  });

  test("non-determinism warnings (dropped-id, unpointed-element, unlisted-navigation) are NOT folded in", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS2322",
              message: "boom",
              file: null,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
          warnings: [
            {
              kind: "dropped-id",
              message: "element lost its stable id",
              line: null,
              column: null,
              file: null,
            },
            {
              kind: "unpointed-element",
              message: "no pointer target",
              line: null,
              column: null,
              file: null,
            },
            {
              kind: "unlisted-navigation",
              message: "navigation target not declared",
              line: null,
              column: null,
              file: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).not.toContain("element lost its stable id");
    expect(result).not.toContain("no pointer target");
    expect(result).not.toContain("navigation target not declared");
  });

  test("import-cycle and dead-module warnings ARE folded in, WITH their file, under their own section (design-tree phase 2 Task 4)", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "import-cycle",
              message: "an import cycle: lib/two.ts -> lib/one.ts -> lib/two.ts",
              line: null,
              column: null,
              file: "lib/one.ts",
            },
            {
              kind: "dead-module",
              message: '"lib/orphan.ts" is not reached by any page\'s resolved closure',
              line: null,
              column: null,
              file: "lib/orphan.ts",
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("an import cycle: lib/two.ts -> lib/one.ts -> lib/two.ts");
    expect(result).toContain("in lib/one.ts");
    expect(result).toContain('"lib/orphan.ts" is not reached');
    expect(result).toContain("in lib/orphan.ts");
    // Not bucketed under the determinism header — DETERMINISM_WARNING_KINDS stays exactly its
    // original two kinds (`unguarded-timer`, `unguarded-randomness`).
    expect(result).not.toContain("non-deterministic code");
  });

  test("no errors and no determinism warnings folds to an empty string", () => {
    const result = foldGateDiagnosticsIntoPrompt(foldInput({ diagnostics: diagnostics() }));
    expect(result).toBe("");
  });

  test("errors present but zero determinism warnings: only the errors section appears", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS2322",
              message: "boom",
              file: null,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
          warnings: [
            { kind: "dropped-id", message: "irrelevant", line: null, column: null, file: null },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("boom");
    // No blank second section, no stray determinism header with nothing under it.
    expect(result.split("\n\n").length).toBe(1);
  });
});

describe("appendPromptFold", () => {
  test("an empty fold leaves the base message unchanged", () => {
    expect(appendPromptFold("please add a footer", "")).toBe("please add a footer");
  });

  test("a non-empty fold is appended after a blank-line separator", () => {
    const result = appendPromptFold("please add a footer", "- [type/TS2322]: boom");
    expect(result).toBe("please add a footer\n\n- [type/TS2322]: boom");
  });
});

describe("foldGateDiagnosticsIntoPrompt — blockedPages reaches the agent (task-14 review round 1, I2)", () => {
  const blocked = (blockedPages: readonly string[] | null) =>
    foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "import",
              code: "FORBIDDEN_IMPORT",
              message: 'specifier "lodash" in lib/theme.ts is rejected',
              file: "lib/theme.ts",
              line: 1,
              column: 1,
              blockedPages: blockedPages as never,
            },
          ],
        }),
      }),
    );

  test("names the pages a shared-module blocker blocked — the one fact the agent cannot derive", () => {
    // MEASURED BEFORE THE FIX: this exact input folded to
    //   "- [import/FORBIDDEN_IMPORT] in lib/theme.ts line 1:1: specifier …"
    // mentioning none of the blocked slugs, while two comments claimed the retry prompt
    // carried them. The diagnostic names the MODULE; the agent has no import graph with which
    // to work out which pages that module broke.
    const result = blocked(["home", "calendar"]);
    if (result instanceof Error) throw result;
    expect(result).toContain("lib/theme.ts");
    expect(result).toContain("blocks: home, calendar");
  });

  test("omits the clause entirely when the fact blocked no page — never an empty list", () => {
    for (const empty of [null, []]) {
      const result = blocked(empty);
      if (result instanceof Error) throw result;
      expect(result).not.toContain("blocks:");
      // …and the diagnostic itself is still rendered, not swallowed with the clause.
      expect(result).toContain("FORBIDDEN_IMPORT");
    }
  });
});

import { describe, expect, test } from "bun:test";

import type { TurnAttempt } from "core/machines";
import { DESIGN_DIRNAME } from "entities/design-tree";

import {
  StaleGateDiagnosticsError,
  type TurnGateDiagnosticsV1,
  type TurnGateFoldInputV1,
  appendPromptFold,
  foldGateDiagnosticsIntoPrompt,
  foldSurvivingWarnings,
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

  test("determinism warnings (nondeterministic-time, nondeterministic-randomness) ARE folded in", () => {
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
              kind: "nondeterministic-time",
              message: "setTimeout without a seeded clock",
              line: 5,
              column: null,
              file: null,
              blockedPages: null,
            },
            {
              kind: "nondeterministic-randomness",
              message: "Math.random without a seed",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("setTimeout without a seeded clock");
    expect(result).toContain("Math.random without a seed");
  });

  /**
   * TASK 4 (design-agent-feedback-loop repair, 2026-08-09) — the renamed vocabulary. Both new
   * kind names must route into the SAME determinism section the old `unguarded-*` names did;
   * the rename changes only what the kind is called, never how it is folded.
   */
  test("the renamed kinds route into the determinism section", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "`Date.now()` is non-deterministic",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
            {
              kind: "nondeterministic-randomness",
              message: "`Math.random()` is non-deterministic",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("Gate also flagged non-deterministic code");
    expect(result).toContain("`Date.now()` is non-deterministic");
    expect(result).toContain("`Math.random()` is non-deterministic");
  });

  test("the four excluded kinds still render under no header", () => {
    for (const kind of [
      "dropped-id",
      "unpointed-element",
      "unlisted-navigation",
      "silencing-any",
    ]) {
      const result = foldGateDiagnosticsIntoPrompt(
        foldInput({
          diagnostics: diagnostics({
            warnings: [
              {
                kind: kind as never,
                message: "m",
                line: null,
                column: null,
                file: "pages/a.tsx",
                blockedPages: null,
              },
            ],
          }),
        }),
      );
      expect(result).toBe("");
    }
  });

  test("the two graph kinds still render under their own header", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "import-cycle",
              message: "an import cycle: lib/a.ts -> lib/b.ts -> lib/a.ts",
              line: null,
              column: null,
              file: "lib/a.ts",
              blockedPages: null,
            },
            {
              kind: "dead-module",
              message: '"lib/orphan.ts" is not reached by any page\'s resolved closure',
              line: null,
              column: null,
              file: "lib/orphan.ts",
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("Gate also flagged the following import-graph issues");
    expect(result).toContain("an import cycle: lib/a.ts -> lib/b.ts -> lib/a.ts");
    expect(result).toContain('"lib/orphan.ts" is not reached');
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
              blockedPages: null,
            },
            {
              kind: "unpointed-element",
              message: "no pointer target",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
            {
              kind: "unlisted-navigation",
              message: "navigation target not declared",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
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
              blockedPages: null,
            },
            {
              kind: "dead-module",
              message: '"lib/orphan.ts" is not reached by any page\'s resolved closure',
              line: null,
              column: null,
              file: "lib/orphan.ts",
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("an import cycle: lib/two.ts -> lib/one.ts -> lib/two.ts");
    expect(result).toContain(`in ${DESIGN_DIRNAME}/lib/one.ts`);
    expect(result).toContain('"lib/orphan.ts" is not reached');
    expect(result).toContain(`in ${DESIGN_DIRNAME}/lib/orphan.ts`);
    // Not bucketed under the determinism header — DETERMINISM_WARNING_KINDS stays exactly its
    // original two kinds (`nondeterministic-time`, `nondeterministic-randomness`).
    expect(result).not.toContain("non-deterministic code");
  });

  test("a determinism warning renders with its file", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "`Date.now()` reads wall-clock time",
              file: "pages/stopwatch.tsx",
              line: 55,
              column: 31,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("pages/stopwatch.tsx");
  });

  test("a warning with no file still omits the clause entirely", () => {
    // The renderer's null-guard is NOT deleted by this task: `TYPE_CHECK_UNAVAILABLE`-shaped
    // whole-tree statements legitimately name no file (core/ports/gate-runner.ts:60-68) — the
    // same shape a warning producer would use for a statement about the tree rather than a file.
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "m",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).not.toContain(" in ");
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
            {
              kind: "dropped-id",
              message: "irrelevant",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
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

describe("foldSurvivingWarnings — warnings that survived an ACCEPTED turn (Task 10)", () => {
  /**
   * `foldSurvivingWarnings` is pure, like `foldGateDiagnosticsIntoPrompt` — no ports, no
   * Reatom. Its input shape is deliberately looser than `TurnGateWarningDtoV1`
   * (`file`/`line`/`column`/`blockedPages` are all optional): the real caller
   * (`core/kernel/model/handlers/turn.ts`'s `resolveSurvivingWarningsFold`) only ever has
   * `entities/chat/types.ts`'s `ChatWarningSnapshot` to hand it. Since Task 11
   * (design-agent-feedback-loop repair, 2026-08-09) that carries `file`/`line` when Gate itself
   * set them — `column`/`blockedPages` are still never persisted there (that type's own doc) —
   * so the test right below exercises the now-common "with a location" case, and the one after
   * it pins the older/absent-file case this whole file used to be the only shape of.
   */

  test("determinism warnings that survived an accepted turn fold into the next turn's prompt", () => {
    const fold = foldSurvivingWarnings({
      warnings: [
        {
          kind: "nondeterministic-time",
          message: "`Date.now()` reads wall-clock time",
          file: "pages/stopwatch.tsx",
          line: 55,
        },
      ],
    });
    expect(fold).toContain(`${DESIGN_DIRNAME}/pages/stopwatch.tsx`);
    expect(fold).toContain("still"); // the header must say these were NOT introduced now
  });

  test("the four excluded kinds are still excluded — same set as the rejection fold", () => {
    for (const kind of [
      "dropped-id",
      "unpointed-element",
      "unlisted-navigation",
      "silencing-any",
    ]) {
      const fold = foldSurvivingWarnings({
        warnings: [{ kind, message: "irrelevant to this fold", file: "pages/a.tsx" }],
      });
      expect(fold).toBe("");
    }
  });

  test("an empty warning list folds to nothing", () => {
    expect(foldSurvivingWarnings({ warnings: [] })).toBe("");
  });

  test("a warning missing file/line (the real shape a ChatWarningSnapshot persists) still folds, with no location clause", () => {
    // `entities/chat/types.ts`'s `ChatWarningSnapshot` carries only `kind`/`message` — this is
    // the ACTUAL shape `resolveSurvivingWarningsFold` hands this function in production, not
    // just a convenience for the richer test above.
    const fold = foldSurvivingWarnings({
      warnings: [{ kind: "nondeterministic-randomness", message: "`Math.random()` is non-deterministic" }],
    });
    expect(fold).toContain("`Math.random()` is non-deterministic");
    expect(fold).not.toContain(" in ");
  });

  test("the surviving fold is not confused with a rejection fold", () => {
    const warnings = [{ kind: "nondeterministic-time", message: "uses Date.now()" }];
    const survivingFold = foldSurvivingWarnings({ warnings });

    const rejectionFold = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "uses Date.now()",
              line: null,
              column: null,
              file: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (rejectionFold instanceof Error) throw rejectionFold;

    // Different header, different implication: a rejection says "fix before anything else"; a
    // survivor says "your last change did not clear this." Telling the agent it was rejected
    // when it was accepted is a NEW lie, not a fix for the old one.
    expect(survivingFold).not.toBe(rejectionFold);
    expect(survivingFold).toContain("PREVIOUS turn was accepted");
    expect(survivingFold).toContain("did not clear them");
    expect(survivingFold).not.toContain("Gate also flagged non-deterministic code");
    expect(survivingFold).not.toContain("Gate rejected the previous attempt");
    expect(rejectionFold).not.toContain("PREVIOUS turn was accepted");
    expect(rejectionFold).not.toContain("did not clear them");
  });

  test("the freshness barrier still governs the rejection fold and does not govern this one", () => {
    // `foldGateDiagnosticsIntoPrompt`'s barrier is ATTEMPT-scoped: a `nextAttempt` that is not
    // exactly `rejectedAttempt + 1` refuses with StaleGateDiagnosticsError.
    const staleRejection = foldGateDiagnosticsIntoPrompt(
      foldInput({ rejectedAttempt: 1 as TurnAttempt, nextAttempt: 4 as TurnAttempt }),
    );
    expect(staleRejection).toBeInstanceOf(StaleGateDiagnosticsError);

    // `foldSurvivingWarnings` crosses TURNS, not attempts, and takes no attempt numbers at all
    // — there is nothing here for that barrier to check, so it can never raise
    // StaleGateDiagnosticsError. ITS freshness rule ("the most recent accepted turn's own
    // warnings, and nothing older") is enforced by the CALLER only ever handing it the chat
    // tail's last record's warnings (`core/kernel/model/handlers/turn.ts`'s
    // `resolveSurvivingWarningsFold`) — not by this pure function, which has no way to tell
    // an old warning from a fresh one on its own. Calling it repeatedly with the same input is
    // idempotent, unlike a call against a stale attempt pair.
    const warnings = [{ kind: "nondeterministic-time", message: "uses Date.now()" }];
    const first = foldSurvivingWarnings({ warnings });
    const second = foldSurvivingWarnings({ warnings });
    expect(first).not.toBeInstanceOf(Error);
    expect(second).not.toBeInstanceOf(Error);
    expect(first).toBe(second);
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

describe("foldGateDiagnosticsIntoPrompt — workspace-relative paths (Task 3)", () => {
  // Gate's `file` is TREE-relative (relative to `design/`); the agent's tools take
  // WORKSPACE-relative paths (the tree is staged one level down, under `design/`, inside the
  // turn workspace). See this file's header and `toWorkspacePath`'s own doc for the full story.

  test("a rejection's error file renders workspace-relative", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TS7006",
              message: "…",
              file: "pages/alarm.tsx",
              line: 98,
              column: 30,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain(`in ${DESIGN_DIRNAME}/pages/alarm.tsx line 98:30`);
    expect(result).not.toContain("in pages/alarm.tsx");
  });

  test("a warning's file renders workspace-relative too", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "…",
              file: "pages/alarm.tsx",
              line: 98,
              column: 30,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain(`in ${DESIGN_DIRNAME}/pages/alarm.tsx line 98:30`);
    expect(result).not.toContain("in pages/alarm.tsx");
  });

  test("a warning's blockedPages renders the same [blocks: …] clause an error's does (Task 5)", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "`Date.now()` reads wall-clock time",
              file: "lib/elapsed.ts",
              line: 1,
              column: 24,
              blockedPages: ["about", "home"] as never,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("lib/elapsed.ts");
    expect(result).toContain("[blocks: about, home]");
  });

  test("a warning's absent blockedPages omits the clause entirely — never an empty list", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          warnings: [
            {
              kind: "nondeterministic-time",
              message: "`Date.now()` reads wall-clock time",
              file: "pages/stopwatch.tsx",
              line: 1,
              column: 24,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).not.toContain("blocks:");
    expect(result).toContain("`Date.now()` reads wall-clock time");
  });

  test("blockedPages still renders SLUGS and is not prefixed", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "import",
              code: "FORBIDDEN_IMPORT",
              message: "…",
              file: "lib/theme.ts",
              line: null,
              column: null,
              blockedPages: ["home", "about"] as never,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).toContain("[blocks: home, about]");
    expect(result).not.toContain(`blocks: ${DESIGN_DIRNAME}/home`);
  });

  test("an absent file still omits the clause, and is never rendered as a bare prefix", () => {
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "TYPE_CHECK_UNAVAILABLE",
              message: "…",
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
    expect(result).not.toContain(" in ");
    expect(result).not.toContain(`${DESIGN_DIRNAME}/\n`);
  });

  test("an already-prefixed file is not double-prefixed", () => {
    // Defensive: nothing produces this today, and if a producer ever starts, a silent
    // `design/design/pages/a.tsx` is a worse failure than an assertion here.
    const result = foldGateDiagnosticsIntoPrompt(
      foldInput({
        diagnostics: diagnostics({
          errors: [
            {
              kind: "type",
              code: "X",
              message: "…",
              file: `${DESIGN_DIRNAME}/pages/a.tsx`,
              line: null,
              column: null,
              blockedPages: null,
            },
          ],
        }),
      }),
    );
    if (result instanceof Error) throw result;
    expect(result).not.toContain(`${DESIGN_DIRNAME}/${DESIGN_DIRNAME}/`);
  });
});

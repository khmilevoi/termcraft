import { describe, expect, test } from "bun:test";

import * as errore from "errore";

import type { PageSlug } from "entities/page";

import type { DesignCheckReportV1 } from "../types";
import {
  DESIGN_CHECK_CLEAN_HEADLINE,
  renderDesignCheckFailure,
  renderDesignCheckReport,
} from "./render";

const empty: DesignCheckReportV1 = { errors: [], warnings: [] };

const HOME = "home" as PageSlug;
const ABOUT = "about" as PageSlug;

describe("renderDesignCheckReport", () => {
  test("a check over a clean tree says so, and says nothing else about problems", () => {
    const text = renderDesignCheckReport(empty);
    expect(text).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    // The clean answer must not manufacture an empty problem section the agent would read
    // as "there is a list here, it just happens to be short".
    expect(text).not.toContain("- [");
    // …and it must still be honest about what a clean check does NOT cover, or the agent
    // reads it as "the Gate will accept this", which is a stronger claim than it can make.
    expect(text).toContain("smoke render");
    expect(text).toContain("page contract");
  });

  test("renders an error and a warning in the retry fold's own line vocabulary", () => {
    const text = renderDesignCheckReport({
      errors: [
        {
          kind: "type",
          code: "TS7006",
          message: "Parameter 'n' implicitly has an 'any' type.",
          file: "pages/home.tsx",
          line: 7,
          column: 22,
          blockedPages: [HOME],
        },
      ],
      warnings: [
        {
          kind: "nondeterministic-time",
          message: "Date.now() is not available in a sealed render",
          file: "lib/elapsed.ts",
          line: 3,
          blockedPages: [HOME, ABOUT],
        },
      ],
    });
    // Task 3's WORKSPACE-relative path vocabulary — the Gate speaks tree-relative, the agent
    // types workspace-relative.
    expect(text).toContain("- [type/TS7006] in design/pages/home.tsx line 7:22 [blocks: home]:");
    // Task 4's kind names, and Task 2's `file` on every warning.
    expect(text).toContain(
      "- [nondeterministic-time] in design/lib/elapsed.ts line 3 [blocks: home, about]:",
    );
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
  });

  test("a tree-wide fatal with no file renders without an empty `in ` clause", () => {
    const text = renderDesignCheckReport({
      errors: [
        {
          kind: "type",
          code: "TYPE_CHECK_UNAVAILABLE",
          message: "the TypeScript compiler could not be run",
        },
      ],
      warnings: [],
    });
    expect(text).toContain("- [type/TYPE_CHECK_UNAVAILABLE]:");
    expect(text).not.toContain(" in :");
  });

  test("a TYPE_CHECK_UNAVAILABLE fatal about the whole tree NEVER renders as a clean pass", () => {
    // `core/ports/gate-runner.ts:60-68`: a fatal about the TREE carries no `file` and no
    // `blockedPages`. Rendering it as "no problems found" is the single worst lie this tool
    // can tell — the agent would finish on the strength of a compiler that never ran.
    const text = renderDesignCheckReport({
      errors: [
        {
          kind: "type",
          code: "TYPE_CHECK_UNAVAILABLE",
          message: "the TypeScript compiler could not be run",
        },
      ],
      warnings: [],
    });
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).toContain("TYPE_CHECK_UNAVAILABLE");
  });

  test("warnings alone are not a clean pass either", () => {
    const text = renderDesignCheckReport({
      errors: [],
      warnings: [{ kind: "import-cycle", message: "a imports b imports a", file: "lib/a.ts" }],
    });
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).toContain("- [import-cycle] in design/lib/a.ts:");
  });

  test("the UI-contract warning kinds the retry fold excludes are excluded here too", () => {
    // Same reason (`core/turns/model/prompt.ts`'s header): UI-contract advisories with no
    // bearing on whether the Gate would reject.
    const text = renderDesignCheckReport({
      errors: [],
      warnings: [
        { kind: "dropped-id", message: "d", file: "pages/home.tsx" },
        { kind: "unpointed-element", message: "u", file: "pages/home.tsx" },
        { kind: "unlisted-navigation", message: "n", file: "pages/home.tsx" },
      ],
    });
    expect(text).toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).not.toContain("dropped-id");
  });

  test("silencing-any DOES render here, unlike in the retry fold", () => {
    // The one deliberate divergence, and it is an addition. This tool is a target the agent
    // optimizes against before finishing, and writing `: any` is the cheapest way to make a
    // type error vanish from its output — calling the laundered version clean would teach
    // exactly that. See `render.ts`'s header.
    const text = renderDesignCheckReport({
      errors: [],
      warnings: [
        { kind: "silencing-any", message: "`any` suppresses a real diagnostic", file: "lib/a.ts" },
      ],
    });
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).toContain("- [silencing-any] in design/lib/a.ts:");
  });

  test("an already-prefixed file is not double-prefixed", () => {
    const text = renderDesignCheckReport({
      errors: [{ kind: "import", code: "X", message: "m", file: "design/lib/a.ts" }],
      warnings: [],
    });
    expect(text).toContain("in design/lib/a.ts");
    expect(text).not.toContain("design/design/");
  });
});

describe("renderDesignCheckFailure", () => {
  class CheckBrokeError extends errore.createTaggedError({
    name: "CheckBrokeError",
    message: "the design tree could not be read at $root",
  }) {}

  test("a check that could not run reports that, never a clean pass", () => {
    const text = renderDesignCheckFailure(new CheckBrokeError({ root: "C:\\ws" }));
    expect(text).not.toContain(DESIGN_CHECK_CLEAN_HEADLINE);
    expect(text).toContain("could not run");
    expect(text).toContain("C:\\ws");
    expect(text).toContain("NOT a clean result");
  });
});

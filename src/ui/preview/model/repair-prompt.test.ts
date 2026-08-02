import { describe, expect, test } from "bun:test";

import { buildRepairPrompt, relativePageSourcePath } from "./repair-prompt";

/**
 * PINS A KNOWN-WRONG VALUE, DELIBERATELY AND VISIBLY (task-14 review round 1, Important 3).
 * `.termcraft/pages/` does not exist after the design-tree plan — canonical storage is
 * `.termcraft/design/<entry>`. This assertion therefore documents the CURRENT, DEFECTIVE
 * output rather than desired behaviour; it exists so a fix produces a visible, deliberate
 * test change instead of a silent one. See `repair-prompt.ts`'s own doc for why the fix is
 * blocked on a wire-DTO widening AND on `design/termcraft-engine.js:1153`, which still draws
 * this same stale path. Registered in `red-debt.md`.
 */
describe("relativePageSourcePath", () => {
  test("is the canonical page layout, project-relative — never absolute", () => {
    expect(relativePageSourcePath("dashboard")).toBe(".termcraft/pages/dashboard/page.tsx");
  });
});

describe("buildRepairPrompt", () => {
  const MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  test("names the page, the file and the verbatim error, and says this is not a Gate rejection", () => {
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: 4 });
    expect(text).toContain('The preview cannot render the "dashboard" page.');
    expect(text).toContain("not a Gate rejection");
    expect(text).toContain("  file:     .termcraft/pages/dashboard/page.tsx");
    expect(text).toContain(`  error:    ${MESSAGE}`);
    expect(text).toContain(
      "  attempts: 4 host incarnations failed before the preview circuit opened",
    );
    expect(text).toContain("this is a repair, not a redesign");
  });

  test("never emits an absolute path", () => {
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: 4 });
    expect(text).not.toMatch(/[A-Za-z]:\\|^\//m);
  });

  test("says one incarnation, singular, when the circuit opened on the first failure", () => {
    // A deterministic failure opens the circuit immediately — there is exactly one dead
    // incarnation and no restarts. "1 host incarnations" would read as a bug in the message
    // the user is about to send to the agent.
    const text = buildRepairPrompt({ pageSlug: "dashboard", safeMessage: MESSAGE, attempts: 1 });
    expect(text).toContain(
      "  attempts: 1 host incarnation failed before the preview circuit opened",
    );
  });
});

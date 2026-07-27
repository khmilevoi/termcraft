import { describe, expect, test } from "bun:test";

import { buildRepairPrompt, relativePageSourcePath } from "./repair-prompt";

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

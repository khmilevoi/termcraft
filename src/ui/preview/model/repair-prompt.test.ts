import { describe, expect, test } from "bun:test";

import { buildRepairPrompt, pageEntryOf, relativePageSourcePath } from "./repair-prompt";

/**
 * UNPINNED THE KNOWN-WRONG VALUE (task 16). Until this task these assertions deliberately and
 * visibly pinned `.termcraft/pages/<slug>/page.tsx` — a path that exists for NO project after
 * the design-tree plan — so that fixing it would produce an obvious test change rather than a
 * silent one. Both things that blocked the fix are now closed: `PageDescriptorV1` carries the
 * page's `entry`, and `design/termcraft-engine.js` draws `.termcraft/design/pages/main.tsx`.
 * Registered in `red-debt.md` as "UI: the repair prompt names a path that cannot exist".
 */
describe("relativePageSourcePath", () => {
  test("is the canonical tree layout, project-relative — never absolute, never slug-derived", () => {
    expect(relativePageSourcePath("pages/dashboard.tsx")).toBe(
      ".termcraft/design/pages/dashboard.tsx",
    );
    // The entry decides the path, so an entry unlike the slug is named as written — the exact
    // case a slug-derived helper could not produce at all.
    expect(relativePageSourcePath("screens/board/overview.tsx")).toBe(
      ".termcraft/design/screens/board/overview.tsx",
    );
  });
});

describe("pageEntryOf", () => {
  const descriptors = [
    { pageSlug: "dashboard", entry: "screens/board/overview.tsx" },
    { pageSlug: "calendar", entry: "pages/calendar.tsx" },
  ];

  test("finds the page's own entry", () => {
    expect(pageEntryOf(descriptors, "dashboard")).toBe("screens/board/overview.tsx");
  });

  test("is null for a page the descriptor list does not name — never a guess", () => {
    expect(pageEntryOf(descriptors, "missing")).toBeNull();
  });
});

describe("buildRepairPrompt", () => {
  const MESSAGE = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";
  const ENTRY = "screens/board/overview.tsx";

  test("names the page, the file and the verbatim error, and says this is not a Gate rejection", () => {
    const text = buildRepairPrompt({
      pageSlug: "dashboard",
      entryRelPath: ENTRY,
      safeMessage: MESSAGE,
      attempts: 4,
    });
    expect(text).toContain('The preview cannot render the "dashboard" page.');
    expect(text).toContain("not a Gate rejection");
    // The page's REAL file, from its manifest entry — the slug appears nowhere in this path.
    expect(text).toContain("  file:     .termcraft/design/screens/board/overview.tsx");
    expect(text).toContain(`  error:    ${MESSAGE}`);
    expect(text).toContain(
      "  attempts: 4 host incarnations failed before the preview circuit opened",
    );
    expect(text).toContain("this is a repair, not a redesign");
  });

  test("never emits an absolute path", () => {
    const text = buildRepairPrompt({
      pageSlug: "dashboard",
      entryRelPath: ENTRY,
      safeMessage: MESSAGE,
      attempts: 4,
    });
    expect(text).not.toMatch(/[A-Za-z]:\\|^\//m);
  });

  test("says one incarnation, singular, when the circuit opened on the first failure", () => {
    // A deterministic failure opens the circuit immediately — there is exactly one dead
    // incarnation and no restarts. "1 host incarnations" would read as a bug in the message
    // the user is about to send to the agent.
    const text = buildRepairPrompt({
      pageSlug: "dashboard",
      entryRelPath: ENTRY,
      safeMessage: MESSAGE,
      attempts: 1,
    });
    expect(text).toContain(
      "  attempts: 1 host incarnation failed before the preview circuit opened",
    );
  });

  test("says the entry is unknown rather than naming a path it cannot know", () => {
    // A page the descriptor list does not name has no file to point at. Inventing one is the
    // whole defect this task closed, so the message states the absence and tells the agent
    // where the binding actually lives.
    const text = buildRepairPrompt({
      pageSlug: "dashboard",
      entryRelPath: null,
      safeMessage: MESSAGE,
      attempts: 4,
    });
    expect(text).toContain('  file:     unknown — "dashboard" has no entry in design/pages.json');
    expect(text).toContain("Find this page's entry in design/pages.json");
    expect(text).not.toContain(".termcraft/design/");
  });
});

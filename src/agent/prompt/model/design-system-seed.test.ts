import { describe, expect, test } from "bun:test";

import { designSystemMigrationSeed } from "./design-system-seed";

describe("designSystemMigrationSeed (design-systems §9)", () => {
  const text = designSystemMigrationSeed({ pageCount: 5 });

  test("names the real page count", () => {
    expect(text).toContain("5 pages");
  });

  test("carries every one of §9's five instructions", () => {
    expect(text).toContain('color="'); // the rewrite it must perform
    expect(text).toContain("color={t.");
    expect(text).toContain("useTokens()");
    expect(text).toContain("design/system/components/");
    expect(text).toContain("design-system.json");
    expect(text).toContain("keyof ThemeTokens");
    expect(text).toContain("meta.theme");
  });

  test("does not ask for a redesign", () => {
    // The same guard `migration-seed.test.ts` already keeps: this turn is a mechanical rewrite,
    // and an agent told to "improve" will.
    for (const forbidden of ["redesign", "improve the design", "new page", "nicer"])
      expect(text.toLowerCase()).not.toContain(forbidden);
  });

  test("a single page reads naturally", () => {
    const single = designSystemMigrationSeed({ pageCount: 1 });
    expect(single).toContain("1 page");
    // "1 page" is a substring of "1 pages" too — a broken pluralization would still pass the
    // assertion above, so also rule out the plural form explicitly.
    expect(single).not.toContain("1 pages");
  });

  test("warns that a moved component's own imports must stay inside design/system/ (Gate §5.1)", () => {
    // Names the Gate's own fatal (`scanSystemContainment`'s `SYSTEM_IMPORT_ESCAPES`,
    // `gate/model/design-system.ts`) so an agent that moves a component with an escaping import
    // understands the failure it is about to hit, rather than discovering it blind.
    expect(text).toContain("SYSTEM_IMPORT_ESCAPES");
    expect(text).toContain("design/system/");
  });
});

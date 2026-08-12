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
    expect(designSystemMigrationSeed({ pageCount: 1 })).toContain("1 page");
  });
});

import { describe, expect, test } from "bun:test";

import { migrationRefactorSeed } from "./migration-seed";

describe("migrationRefactorSeed (design-tree §12.2 track 2)", () => {
  test("asks for shared modules and names the tree it may write into", () => {
    const seed = migrationRefactorSeed({ pageCount: 3 });
    expect(seed).toContain("design/");
    expect(seed.toLowerCase()).toContain("shared");
    expect(seed.length).toBeGreaterThan(0);
  });

  test("states that the pages already work, so a no-op is an acceptable answer", () => {
    expect(migrationRefactorSeed({ pageCount: 3 }).toLowerCase()).toContain(
      "if there is nothing worth sharing",
    );
  });

  test("never asks for a visual change", () => {
    const seed = migrationRefactorSeed({ pageCount: 2 }).toLowerCase();
    expect(seed).toContain("identical");
    for (const forbidden of ["redesign", "improve the design", "new page"])
      expect(seed).not.toContain(forbidden);
  });

  test("reports the real page count", () => {
    expect(migrationRefactorSeed({ pageCount: 1 })).toContain("1 page");
    expect(migrationRefactorSeed({ pageCount: 4 })).toContain("4 pages");
  });
});

import { describe, expect, test } from "bun:test";

import { designSystemMigrationSeed } from "./design-system-seed";
import { formatOneMigrationSeed } from "./format-one-migration-seed";
import { migrationRefactorSeed } from "./migration-seed";

describe("formatOneMigrationSeed (design-tree §12.2 track 2 + design-systems §9)", () => {
  test("carries both underlying seeds verbatim", () => {
    const combined = formatOneMigrationSeed({ pageCount: 3 });
    expect(combined).toContain(migrationRefactorSeed({ pageCount: 3 }));
    expect(combined).toContain(designSystemMigrationSeed({ pageCount: 3 }));
  });

  test("bridges the two so they no longer contradict each other", () => {
    // Without a bridge, `migrationRefactorSeed` tells the agent to extract shared markup INTO
    // design/components/, while `designSystemMigrationSeed`'s instruction 2 tells it to move a
    // shared component OUT of design/components/ and into design/system/components/ — a bare
    // concatenation reads as "extract here, then relocate there". The bridge names one
    // destination up front instead.
    const combined = formatOneMigrationSeed({ pageCount: 3 });
    expect(combined).toContain("as ONE move");
    expect(combined).toContain("design/system/components/");
  });

  test("the format-2 seed alone carries no bridge — only the format-1 join does", () => {
    // Guards against the bridge sentence leaking into `designSystemMigrationSeed` itself, which
    // format-2 origins use unjoined (`bootstrap.ts`'s ternary never calls this function for them).
    expect(designSystemMigrationSeed({ pageCount: 3 })).not.toContain("as ONE move");
  });
});

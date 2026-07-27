import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { buildRuntimeDocs } from "./runtime-docs";

describe("buildRuntimeDocs", () => {
  test("returns the runtime declaration and both authoring guides, flat at the workspace root", () => {
    const docs = buildRuntimeDocs();
    expect(docs.map((d) => d.relPath).sort()).toEqual(["REATOM.md", "RUNTIME.md", "runtime.d.ts"]);
  });

  /**
   * The staged names and `store/safe-fs`'s workspace grammar are a pair: a doc staged under
   * a name `classifyWorkspace` does not accept is written into the workspace and then
   * unreadable through `SafeProjectFs`. `store/safe-fs/model/limits.test.ts` asserts the
   * other half of the same pair.
   */
  test("every staged doc name is one store/safe-fs classifies as an agent runtime doc", () => {
    for (const doc of buildRuntimeDocs()) {
      expect(doc.relPath.endsWith(".md") || doc.relPath.endsWith(".d.ts")).toBe(true);
      expect(doc.relPath).not.toContain("/");
    }
  });

  test("every returned sourcePath resolves to a real file on disk", () => {
    for (const doc of buildRuntimeDocs()) {
      expect(fs.existsSync(doc.sourcePath)).toBe(true);
    }
  });
});

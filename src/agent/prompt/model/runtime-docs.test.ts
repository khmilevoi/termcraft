import { describe, expect, test } from "bun:test";
import fs from "node:fs";

import { buildRuntimeDocs } from "./runtime-docs";

describe("buildRuntimeDocs", () => {
  test("returns the runtime declaration and the authoring guide, flat at the workspace root", () => {
    const docs = buildRuntimeDocs();
    expect(docs.map((d) => d.relPath).sort()).toEqual(["RUNTIME.md", "runtime.d.ts"]);
  });

  test("every returned sourcePath resolves to a real file on disk", () => {
    for (const doc of buildRuntimeDocs()) {
      expect(fs.existsSync(doc.sourcePath)).toBe(true);
    }
  });
});

import { describe, expect, test } from "bun:test";

import {
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  DESIGN_SYSTEM_TOKENS_RELPATH,
  decodeDesignSystemManifest,
} from "entities/design-system";

import { createDesignSystemSeedFiles } from "./design-system-seed";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("createDesignSystemSeedFiles (design-systems §4.4, §9)", () => {
  const files = createDesignSystemSeedFiles({ kitApiVersion: 1 });

  test("emits exactly the manifest and the typed accessor, in that order", () => {
    expect(files.map((f) => f.relPath)).toEqual([
      DESIGN_SYSTEM_MANIFEST_RELPATH,
      DESIGN_SYSTEM_TOKENS_RELPATH,
    ]);
  });

  test("paths are TREE-relative — the caller adds the design/ prefix", () => {
    for (const file of files) expect(file.relPath.startsWith("design/")).toBe(false);
  });

  test("the manifest decodes and declares the seed palette", () => {
    const decoded = decodeDesignSystemManifest(text(files[0]!.bytes));
    expect(decoded).not.toBeInstanceOf(Error);
    if (decoded instanceof Error) return;
    expect(decoded.themes["dark-default"]?.tokens.accent).toBe("#e6a23c");
  });

  test("the accessor names the manifest's defaultTheme", () => {
    expect(text(files[1]!.bytes)).toContain('["themes"]["dark-default"]["tokens"]');
  });

  test("byte-deterministic — two calls produce identical bytes", () => {
    const again = createDesignSystemSeedFiles({ kitApiVersion: 1 });
    expect(text(again[0]!.bytes)).toBe(text(files[0]!.bytes));
    expect(text(again[1]!.bytes)).toBe(text(files[1]!.bytes));
  });
});

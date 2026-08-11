import { describe, expect, test } from "bun:test";

import {
  designSystemComponentRelPath,
  findUnresolvedComponents,
  isInsideDesignSystem,
} from "./components";
import { decodeDesignSystemManifest } from "./manifest";
import { validManifestObject } from "./manifest.fixture";

const manifest = (() => {
  const m = decodeDesignSystemManifest(JSON.stringify(validManifestObject()));
  if (m instanceof Error) throw new Error("fixture manifest must decode");
  return m;
})();

describe("designSystemComponentRelPath", () => {
  test("prefixes the module with the system directory", () => {
    expect(designSystemComponentRelPath(manifest.components[0]!)).toBe(
      "system/components/Button.tsx",
    );
  });
});

describe("findUnresolvedComponents", () => {
  test("returns nothing when every module names a tree file", () => {
    const present = new Set(["system/components/Button.tsx", "system/components/PageShell.tsx"]);
    expect(findUnresolvedComponents({ manifest, has: (p) => present.has(p) })).toEqual([]);
  });

  test("returns exactly the entries whose module names no tree file", () => {
    const present = new Set(["system/components/Button.tsx"]);
    const unresolved = findUnresolvedComponents({ manifest, has: (p) => present.has(p) });
    expect(unresolved.map((c) => c.name)).toEqual(["PageShell"]);
  });

  test("resolution is exact — there is no extension probing", () => {
    const present = new Set(["system/components/Button.ts", "system/components/PageShell.tsx"]);
    const unresolved = findUnresolvedComponents({ manifest, has: (p) => present.has(p) });
    expect(unresolved.map((c) => c.name)).toEqual(["Button"]);
  });
});

describe("isInsideDesignSystem", () => {
  test.each([
    ["system/tokens.ts", true],
    ["system/components/Button.tsx", true],
    ["system/design-system.json", true],
    ["pages/dashboard.tsx", false],
    ["lib/time.ts", false],
    ["systemic/x.ts", false], // prefix, not a directory boundary
    ["system", false], // the directory itself is not a file inside it
  ])("%s -> %s", (relPath, expected) => {
    expect(isInsideDesignSystem(relPath)).toBe(expected);
  });
});

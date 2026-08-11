import { describe, expect, test } from "bun:test";

import { DESIGN_SYSTEM_MANIFEST_RELPATH } from "entities/design-system";
import { validManifestObject } from "entities/design-system/model/manifest.fixture";

import { checkDesignSystemSlice, hasDesignSystem } from "./design-system";

const BUTTON = `export const Button = (props: { id: string }) => props.id\n`;
const SHELL = `export function PageShell() { return null }\n`;

function tree(
  overrides: Record<string, string> = {},
  mutate: (o: any) => void = () => {},
): { files: Map<string, string>; treePaths: string[] } {
  const manifest = validManifestObject();
  mutate(manifest);
  const files = new Map<string, string>([
    [DESIGN_SYSTEM_MANIFEST_RELPATH, JSON.stringify(manifest, null, 2) + "\n"],
    ["system/components/Button.tsx", BUTTON],
    ["system/components/PageShell.tsx", SHELL],
    ...Object.entries(overrides),
  ]);
  return { files, treePaths: [...files.keys()] };
}

describe("hasDesignSystem — the transitional rule (decision D8)", () => {
  test("a tree with no manifest declares no design system", () => {
    expect(hasDesignSystem(["pages/a.tsx", "pages.json"])).toBe(false);
  });
  test("a tree with the manifest declares one", () => {
    expect(hasDesignSystem(["pages.json", DESIGN_SYSTEM_MANIFEST_RELPATH])).toBe(true);
  });
});

describe("checkDesignSystemSlice", () => {
  test("a tree with no design system produces nothing at all", () => {
    const result = checkDesignSystemSlice({
      files: new Map([["pages/a.tsx", "export default 1"]]),
      treePaths: ["pages/a.tsx"],
    });
    expect(result).toEqual({ errors: [], manifest: null, unverified: false, componentRoots: [] });
  });

  test("a valid design system decodes and yields both component roots", () => {
    const result = checkDesignSystemSlice(tree());
    expect(result.errors).toEqual([]);
    expect(result.manifest?.id).toBe("midnight");
    expect(result.unverified).toBe(false);
    expect(result.componentRoots).toEqual([
      "system/components/Button.tsx",
      "system/components/PageShell.tsx",
    ]);
  });

  test("a manifest present in the tree but with no source text is DESIGN_SYSTEM_SOURCE_MISSING", () => {
    const t = tree();
    t.files.delete(DESIGN_SYSTEM_MANIFEST_RELPATH);
    const result = checkDesignSystemSlice({ files: t.files, treePaths: t.treePaths });
    expect(result.errors.map((e) => e.code)).toEqual(["DESIGN_SYSTEM_SOURCE_MISSING"]);
    expect(result.errors[0]?.kind).toBe("manifest");
    expect(result.errors[0]?.file).toBe(DESIGN_SYSTEM_MANIFEST_RELPATH);
    expect(result.unverified).toBe(true);
    expect(result.componentRoots).toEqual([]);
  });

  test("a manifest that does not decode is ONE fatal, and the tree is unverified", () => {
    const t = tree();
    t.files.set(DESIGN_SYSTEM_MANIFEST_RELPATH, "{ not json");
    const result = checkDesignSystemSlice(t);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.code).toBe("JSON_PARSE");
    expect(result.errors[0]?.kind).toBe("manifest");
    expect(result.errors[0]?.file).toBe(DESIGN_SYSTEM_MANIFEST_RELPATH);
    expect(result.manifest).toBeNull();
    expect(result.unverified).toBe(true);
  });

  test.each([
    [
      "a missing core role",
      (o: any) => {
        delete o.themes.dark.tokens.dangerDim;
      },
      "MISSING_CORE_ROLE",
    ],
    [
      "a parity break",
      (o: any) => {
        o.themes.light = { label: "L", tokens: { ...o.themes.dark.tokens } };
        delete o.themes.light.tokens.chartSeries1;
      },
      "TOKEN_PARITY",
    ],
    [
      "a non-hex token value",
      (o: any) => {
        o.themes.dark.tokens.accent = "blue";
      },
      "themes.tokens",
    ],
    [
      "an undeclared defaultTheme",
      (o: any) => {
        o.defaultTheme = "solar";
      },
      "DEFAULT_THEME_UNDECLARED",
    ],
  ])("%s is one fatal on the manifest (%s)", (_label, mutate, code) => {
    const result = checkDesignSystemSlice(tree({}, mutate));
    expect(result.errors.map((e) => e.code)).toEqual([code]);
    expect(result.errors[0]?.file).toBe(DESIGN_SYSTEM_MANIFEST_RELPATH);
    expect(result.unverified).toBe(true);
  });

  test("an unsupported kitApiVersion is UNSUPPORTED_KIT_API", () => {
    const result = checkDesignSystemSlice(
      tree({}, (o: any) => {
        o.kitApiVersion = 99;
      }),
    );
    expect(result.errors.map((e) => e.code)).toEqual(["UNSUPPORTED_KIT_API"]);
    expect(result.errors[0]?.message).toContain("99");
    expect(result.unverified).toBe(true);
    // The manifest DID decode, but `manifest` is still null: Task 6's `runTree` wiring must
    // suppress the containment scan and the `meta.theme` check exactly as it does for a manifest
    // that failed to decode — a system this binary cannot target gets ONE fatal, not one PLUS a
    // containment fatal PLUS a theme fatal per page.
    expect(result.manifest).toBeNull();
    expect(result.componentRoots).toEqual([]);
  });

  test("a components[] entry naming no tree file is DESIGN_SYSTEM_COMPONENT_UNRESOLVED", () => {
    const t = tree();
    t.files.delete("system/components/PageShell.tsx");
    const result = checkDesignSystemSlice({ files: t.files, treePaths: [...t.files.keys()] });
    expect(result.errors.map((e) => e.code)).toEqual(["DESIGN_SYSTEM_COMPONENT_UNRESOLVED"]);
    expect(result.errors[0]?.message).toContain("PageShell");
    expect(result.errors[0]?.message).toContain("system/components/PageShell.tsx");
    expect(result.unverified).toBe(true);
    // The RESOLVING sibling is still a root — one broken entry does not disarm the other.
    expect(result.componentRoots).toEqual(["system/components/Button.tsx"]);
  });

  test("a module that resolves but exports no such binding is DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING", () => {
    const result = checkDesignSystemSlice(
      tree({ "system/components/Button.tsx": "export const Btn = 1\n" }),
    );
    expect(result.errors.map((e) => e.code)).toEqual(["DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING"]);
    expect(result.errors[0]?.file).toBe("system/components/Button.tsx");
    expect(result.errors[0]?.message).toContain("Button");
    expect(result.unverified).toBe(true);
  });

  test("a default-only module does not satisfy a named binding", () => {
    const result = checkDesignSystemSlice(
      tree({ "system/components/Button.tsx": "export default 1\n" }),
    );
    expect(result.errors.map((e) => e.code)).toEqual(["DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING"]);
  });

  test("a NON-EXHAUSTIVE export scan does NOT manufacture a missing-binding fatal", () => {
    const result = checkDesignSystemSlice(
      tree({ "system/components/Button.tsx": "export const { Button } = kit\n" }),
    );
    expect(result.errors).toEqual([]);
    expect(result.componentRoots).toContain("system/components/Button.tsx");
  });

  test("an unresolved component and an export-missing component both fatal — fan-out, not short-circuit (B-1)", () => {
    // Every other component-fatal test above produces exactly ONE error, so an implementation
    // that `return`ed after the first fatal instead of accumulating would pass all of them —
    // including the `componentRoots` check, since Button precedes PageShell in the fixture and
    // an early return yields the same prefix. This case breaks BOTH components at once, each a
    // DIFFERENT fatal code, so only an implementation that keeps checking every component after
    // the first failure can produce both.
    const t = tree({ "system/components/Button.tsx": "export const Btn = 1\n" });
    t.files.delete("system/components/PageShell.tsx");
    const result = checkDesignSystemSlice({ files: t.files, treePaths: [...t.files.keys()] });
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING",
      "DESIGN_SYSTEM_COMPONENT_UNRESOLVED",
    ]);
    expect(result.unverified).toBe(true);
    expect(result.componentRoots).toEqual(["system/components/Button.tsx"]);
  });

  test("every fatal carries no blockedPages — a manifest fault names no page (D6)", () => {
    const result = checkDesignSystemSlice(
      tree({}, (o: any) => {
        o.defaultTheme = "solar";
      }),
    );
    for (const error of result.errors) expect(error.blockedPages).toBeUndefined();
  });
});

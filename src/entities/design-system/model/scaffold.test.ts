import { describe, expect, test } from "bun:test";

import { DESIGN_SYSTEM_TOKENS_RELPATH } from "../types";
import { decodeDesignSystemManifest } from "./manifest";
import { renderDesignSystemManifest, renderTokensScaffold } from "./scaffold";
import { createSeedManifest } from "./seed";

const manifest = createSeedManifest({ kitApiVersion: 1 });

describe("renderDesignSystemManifest", () => {
  test("is pretty-printed JSON with a trailing newline", () => {
    const text = renderDesignSystemManifest(manifest);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "id": "default"');
  });

  test("is byte-deterministic — the same manifest renders identically twice", () => {
    expect(renderDesignSystemManifest(manifest)).toBe(renderDesignSystemManifest(manifest));
  });

  test("round-trips through the decoder", () => {
    expect(decodeDesignSystemManifest(renderDesignSystemManifest(manifest))).toEqual(manifest);
  });
});

describe("renderTokensScaffold (spec §4.3)", () => {
  const text = renderTokensScaffold(manifest);

  test("writes the defaultTheme's LITERAL name into the indexed access", () => {
    expect(text).toContain('["themes"]["dark-default"]["tokens"]');
  });

  test("uses the mapped type, never a bare indexed access", () => {
    // The mapped type is what re-types each JSON string value as `Color`; a bare indexed access
    // would carry `string` into every colour prop and fail every `t.<token>` read.
    expect(text).toContain("export type Tokens = { [K in keyof");
    expect(text).toContain("]: Color }");
  });

  test("imports the runtime hook under an alias and re-exports the bound one", () => {
    expect(text).toContain(
      'import { useTokens as useRuntimeTokens, type Color } from "@termcraft/runtime"',
    );
    expect(text).toContain('import ds from "./design-system.json"');
    expect(text).toContain("export const useTokens = () => useRuntimeTokens<Tokens>()");
  });

  test("ends with a newline and is byte-deterministic", () => {
    expect(text.endsWith("\n")).toBe(true);
    expect(renderTokensScaffold(manifest)).toBe(text);
  });

  test("a manifest with a different defaultTheme writes THAT name", () => {
    const other = {
      ...manifest,
      defaultTheme: "midnight",
      themes: { midnight: manifest.themes["dark-default"]! },
    };
    expect(renderTokensScaffold(other)).toContain('["themes"]["midnight"]["tokens"]');
  });

  test("the scaffold's own relPath constant is the file this text belongs at", () => {
    expect(DESIGN_SYSTEM_TOKENS_RELPATH).toBe("system/tokens.ts");
  });
});

import { afterEach, describe, expect, test } from "bun:test";

import {
  defineTweaks,
  hostModeAtom,
  isExport,
  isExportAtom,
  themeCapability,
} from "./capabilities";
import { themeTokens } from "./tokens";

afterEach(() => hostModeAtom.set("preview"));

describe("runtime capabilities (§6)", () => {
  test("defineTweaks records the declaration unchanged (dormant MVP)", () => {
    const decl = { density: { kind: "select", options: ["compact", "cozy"] } };
    expect(defineTweaks(decl)).toBe(decl);
  });

  test("isExport reflects the host-scoped mode atom", () => {
    expect(isExport()).toBe(false);
    expect(isExportAtom()).toBe(false);
    hostModeAtom.set("export");
    expect(isExport()).toBe(true);
    expect(isExportAtom()).toBe(true);
  });

  test("themeCapability resolves the active theme id + tokens", () => {
    const cap = themeCapability();
    expect(cap.themeId).toBe("dark-default");
    expect(cap.tokens).toBe(themeTokens("dark-default"));
  });
});

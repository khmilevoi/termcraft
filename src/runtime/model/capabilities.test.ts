import { afterEach, describe, expect, test } from "bun:test";

import {
  defineTweaks,
  hostModeAtom,
  isExport,
  isExportAtom,
  themeCapability,
  usePages,
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

describe("navigation capability (§6, design §5.5)", () => {
  test("usePages().goTo is a callable, dormant no-op in MVP (M16)", () => {
    const pages = usePages();
    expect(typeof pages.goTo).toBe("function");
    // DORMANT: the host-protocol emission and shell tab switch land in phase 7 —
    // calling it now records/emits nothing observable, so the only current
    // contract is that it is callable and returns nothing.
    expect(pages.goTo("settings")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import * as runtime from "./index";

/**
 * The facade contract (runtime-api §11.1): every §3.2 public family symbol is
 * exported from the single entry point, and that entry point leaks no private
 * dependency identity (@reatom/*, react, @opentui/*) into the authored-page surface
 * (§3.3).
 */
describe("@termcraft/runtime facade contract (§11.1)", () => {
  test("exports the page contract + capability functions", () => {
    for (const name of [
      "definePage",
      "themeTokens",
      "defineTweaks",
      "isExport",
      "themeCapability",
      "usePages",
    ] as const) {
      // `name` is a member of the `as const` list above, so tsc already checks it
      // against runtime's real export keys — a typo fails the type check, not just
      // this assertion.
      // oxlint-disable-next-line import/namespace
      expect(typeof runtime[name]).toBe("function");
    }
    expect(runtime.CURRENT_KIT_API_VERSION).toBe(1);
    expect(runtime.DEFAULT_THEME_ID).toBe("dark-default");
  });

  test("re-exports the Reatom state + async + React families under the facade", () => {
    for (const name of [
      "atom",
      "computed",
      "action",
      "wrap",
      "withAsync",
      "withAsyncData",
      "withComputed",
      "withAbort",
      "withConnectHook",
      "reatomComponent",
    ] as const) {
      // See the rationale on the first loop above: tsc already validates `name`.
      // oxlint-disable-next-line import/namespace
      expect(typeof runtime[name]).toBe("function");
    }
  });

  test("exports the JSX helper surface", () => {
    expect(typeof runtime.jsx).toBe("function");
    expect(typeof runtime.jsxs).toBe("function");
    expect(typeof runtime.jsxDEV).toBe("function");
    expect(runtime.Fragment).toBeDefined();
  });

  test("exports the full 13-component design-system catalog + the low-level Box escape hatch", () => {
    for (const name of [
      "Row",
      "Column",
      "Panel",
      "Separator",
      "Spacer",
      "Text",
      "Button",
      "Input",
      "Tabs",
      "List",
      "Table",
      "Gauge",
      "Sparkline",
      "Box",
    ] as const) {
      // See the rationale on the first loop above: tsc already validates `name`.
      // oxlint-disable-next-line import/namespace
      expect(typeof runtime[name]).toBe("function");
    }
  });

  test("the public entry point names no private dependency identity (§3.3)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // The facade re-exports only from its own ./model/* and ./ui/* — never a bare
    // @reatom / @opentui / react import specifier, so authored pages never see them.
    // (Matches import/export specifiers, not prose in comments describing the policy.)
    expect(source).not.toMatch(/from\s+["']@reatom/);
    expect(source).not.toMatch(/from\s+["']@opentui/);
    expect(source).not.toMatch(/from\s+["']react["'/]/);
  });
});

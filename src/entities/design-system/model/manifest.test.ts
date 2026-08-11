import { describe, expect, test } from "bun:test";

import type { ThemeTokens } from "runtime";

import { CORE_TOKEN_ROLES } from "../types";
import type { CoreTokenRole } from "../types";
import { DesignSystemManifestInvalidError, decodeDesignSystemManifest } from "./manifest";
import { validManifestObject } from "./manifest.fixture";

/** D3's drift guard: a compile error the moment the entity's roles and `ThemeTokens` diverge. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _rolesMatchThemeTokens: Exact<CoreTokenRole, keyof ThemeTokens> = true;

const decode = (o: unknown) => decodeDesignSystemManifest(JSON.stringify(o));

describe("decodeDesignSystemManifest", () => {
  test("the spec §3.2 manifest round-trips", () => {
    const result = decode(validManifestObject());
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    expect(result.id).toBe("midnight");
    expect(result.defaultTheme).toBe("dark");
    expect(Object.keys(result.themes)).toEqual(["dark"]);
    expect(result.themes.dark?.tokens.brandBlue).toBe("#4cc9f0");
    expect(result.components.map((c) => c.name)).toEqual(["Button", "PageShell"]);
  });

  test("invalid JSON is JSON_PARSE, never a throw", () => {
    const result = decodeDesignSystemManifest("{ not json");
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe("JSON_PARSE");
  });

  test.each([
    [
      "schemaVersion",
      (o: any) => {
        o.schemaVersion = 2;
      },
      "schemaVersion",
    ],
    [
      "an unknown top-level key",
      (o: any) => {
        o.extra = 1;
      },
      "SHAPE",
    ],
    [
      "a missing id",
      (o: any) => {
        delete o.id;
      },
      "id",
    ],
    [
      "a non-slug id",
      (o: any) => {
        o.id = "Mid Night";
      },
      "id",
    ],
    [
      "an empty name",
      (o: any) => {
        o.name = "";
      },
      "name",
    ],
    [
      "an empty version",
      (o: any) => {
        o.version = "";
      },
      "version",
    ],
    [
      "a zero kitApiVersion",
      (o: any) => {
        o.kitApiVersion = 0;
      },
      "kitApiVersion",
    ],
    [
      "a fractional kitApiVersion",
      (o: any) => {
        o.kitApiVersion = 1.5;
      },
      "kitApiVersion",
    ],
    [
      "an empty themes map",
      (o: any) => {
        o.themes = {};
      },
      "themes",
    ],
    [
      "a non-slug theme id",
      (o: any) => {
        o.themes.Dark = o.themes.dark;
        delete o.themes.dark;
        o.defaultTheme = "Dark";
      },
      "themes",
    ],
    [
      "a theme with no label",
      (o: any) => {
        delete o.themes.dark.label;
      },
      "themes.label",
    ],
    [
      "an uppercase hex value",
      (o: any) => {
        o.themes.dark.tokens.accent = "#4CC9F0";
      },
      "themes.tokens",
    ],
    [
      "a three-digit hex value",
      (o: any) => {
        o.themes.dark.tokens.accent = "#abc";
      },
      "themes.tokens",
    ],
    [
      "a named colour",
      (o: any) => {
        o.themes.dark.tokens.accent = "blue";
      },
      "themes.tokens",
    ],
    [
      "a token name that is not an identifier",
      (o: any) => {
        o.themes.dark.tokens["chart-1"] = "#111111";
      },
      "themes.tokens",
    ],
    [
      "a component with no export",
      (o: any) => {
        delete o.components[0].export;
      },
      "components.export",
    ],
    [
      "a component module that escapes system/",
      (o: any) => {
        o.components[0].module = "../lib/x.tsx";
      },
      "components.module",
    ],
    [
      "a component module with a backslash",
      (o: any) => {
        o.components[0].module = "components\\Button.tsx";
      },
      "components.module",
    ],
    [
      "an absolute component module",
      (o: any) => {
        o.components[0].module = "/x.tsx";
      },
      "components.module",
    ],
  ])("rejects %s under code %s", (_label, mutate, code) => {
    const o = validManifestObject();
    mutate(o);
    const result = decode(o);
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe(code);
  });

  // Spread into a mutable array: `test.each`'s single-value overload requires `T[]`, and
  // `CORE_TOKEN_ROLES` is a readonly tuple — passed directly it fails all three overloads and
  // `role` infers as `unknown` (tsc-verified; `bun test` type-strips and would not have caught it).
  test.each([...CORE_TOKEN_ROLES])(
    "a theme omitting the core role %s is MISSING_CORE_ROLE",
    (role) => {
      const o = validManifestObject() as any;
      delete o.themes.dark.tokens[role];
      const result = decode(o);
      expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
      if (!(result instanceof DesignSystemManifestInvalidError)) return;
      expect(result.code).toBe("MISSING_CORE_ROLE");
      expect(result.message).toContain(role);
    },
  );

  test("a token declared in one theme but not another is TOKEN_PARITY", () => {
    const o = validManifestObject() as any;
    o.themes.light = { label: "Midnight Light", tokens: { ...o.themes.dark.tokens } };
    delete o.themes.light.tokens.brandBlue;
    const result = decode(o);
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe("TOKEN_PARITY");
    expect(result.message).toContain("brandBlue");
  });

  test("two themes with identical token names decode", () => {
    const o = validManifestObject() as any;
    o.themes.light = { label: "Midnight Light", tokens: { ...o.themes.dark.tokens } };
    expect(decode(o)).not.toBeInstanceOf(Error);
  });

  test("defaultTheme naming an undeclared theme is DEFAULT_THEME_UNDECLARED", () => {
    const o = validManifestObject() as any;
    o.defaultTheme = "light";
    const result = decode(o);
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe("DEFAULT_THEME_UNDECLARED");
  });

  test("two components sharing a name is DUPLICATE_COMPONENT", () => {
    const o = validManifestObject() as any;
    o.components[1].name = "Button";
    const result = decode(o);
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe("DUPLICATE_COMPONENT");
  });

  test("an empty components array is legal", () => {
    const o = validManifestObject() as any;
    o.components = [];
    expect(decode(o)).not.toBeInstanceOf(Error);
  });

  test("a code never names an array index", () => {
    const o = validManifestObject() as any;
    delete o.components[1].export;
    const result = decode(o);
    expect(result).toBeInstanceOf(DesignSystemManifestInvalidError);
    if (!(result instanceof DesignSystemManifestInvalidError)) return;
    expect(result.code).toBe("components.export"); // NOT `components.1.export`
  });
});

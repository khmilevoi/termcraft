import { describe, expect, test } from "bun:test";

import { scanImportAllowlist } from "./import-scan";

const clean = `import { definePage, Panel, Text, atom, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "X", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{atom(1, "x")()}</Text></Panel>)
`;

describe("scanImportAllowlist (§3.1 authoritative module-edge allowlist)", () => {
  test("a clean page importing only the bare runtime root passes", () => {
    expect(scanImportAllowlist(clean)).toEqual([]);
  });

  test("a type-only import from the runtime root is legal", () => {
    const errors = scanImportAllowlist(
      `import type { PageMeta } from "@termcraft/runtime"\nexport const x = 1\n`,
    );
    expect(errors).toEqual([]);
  });

  test("a value import from a foreign module is rejected", () => {
    const errors = scanImportAllowlist(`import { useState } from "react"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    expect(errors[0]?.message).toContain("react");
  });

  test("a type-only import from a foreign module is rejected (type edges are scanned)", () => {
    const errors = scanImportAllowlist(`import type { X } from "./local"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a runtime subpath is rejected (only the bare root is legal)", () => {
    const errors = scanImportAllowlist(`import { jsx } from "@termcraft/runtime/jsx-runtime"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a side-effect import is rejected even from the runtime root reasons aside — foreign is rejected", () => {
    expect(scanImportAllowlist(`import "./side-effect"\n`)[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a dynamic import is rejected even when it names the runtime", () => {
    const errors = scanImportAllowlist(`const m = await import("@termcraft/runtime")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("DYNAMIC_IMPORT");
  });

  test("a re-export from the runtime is rejected (one page, no runtime-selected loading)", () => {
    const errors = scanImportAllowlist(`export { atom } from "@termcraft/runtime"\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REEXPORT");
  });

  test("a bare re-export of a foreign module is rejected", () => {
    expect(scanImportAllowlist(`export * from "./other"\n`)[0]?.code).toBe("REEXPORT");
  });

  test("a CJS require is rejected", () => {
    const errors = scanImportAllowlist(`const react = require("react")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REQUIRE_CALL");
  });

  test("a local export is NOT a module edge (no false positive)", () => {
    expect(scanImportAllowlist(`export const label = "danger"\nexport default 1\n`)).toEqual([]);
  });

  test("import.meta is not a module edge", () => {
    expect(scanImportAllowlist(`const u = import.meta.url\n`)).toEqual([]);
  });

  test("a JSX string-attribute value is not mistaken for an import specifier", () => {
    const src = `import { Text } from "@termcraft/runtime"\nexport default () => <Text id="t" color="danger">hi "quoted"</Text>\n`;
    expect(scanImportAllowlist(src)).toEqual([]);
  });

  test("reports every offending edge, not just the first", () => {
    const errors = scanImportAllowlist(
      `import "react"\nimport { x } from "lodash"\nrequire("fs")\n`,
    );
    expect(errors.length).toBe(3);
  });

  test("an eval(...) call is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanImportAllowlist(`const x = eval("1 + 1")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("EVAL_CALL");
    expect(errors[0]?.message).toContain("eval");
  });

  test("a new Function(...) construction is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanImportAllowlist(`const f = new Function("a", "return a")\n`);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FUNCTION_CALL");
    expect(errors[0]?.message).toContain("Function");
  });

  test("a method named eval on some object is not mistaken for the global eval", () => {
    expect(scanImportAllowlist(`obj.eval("x")\n`)).toEqual([]);
  });

  describe("Important 2 — optional chaining before eval is not a fatal false rejection", () => {
    test("obj?.eval(...) is not mistaken for the global eval", () => {
      expect(scanImportAllowlist(`obj?.eval("x")\n`)).toEqual([]);
    });
  });

  describe("Important 3 — eval/Function evasions the token scanner now catches", () => {
    test('a bare eval reference smuggled through the comma operator ((0, eval)("x")) is caught', () => {
      const errors = scanImportAllowlist(`(0, eval)("x")\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("an eval reference aliased to a variable then invoked later is caught at the point of reference", () => {
      const errors = scanImportAllowlist(`const e = eval\ne("x")\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a bare eval reference with no call at all is still caught (assignment alone reaches the capability)", () => {
      const errors = scanImportAllowlist(`const e = eval\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a computed-string eval access (globalThis["eval"](...)) is caught', () => {
      const errors = scanImportAllowlist(`globalThis["eval"]("x")\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a bare Function call without new (Function("a", "return a")(1)) is caught', () => {
      const errors = scanImportAllowlist(`Function("a", "return a")(1)\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('a computed-string Function access (g["Function"](...)) is caught', () => {
      const errors = scanImportAllowlist(`g["Function"]("a", "return a")\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a method named Function on some object is not mistaken for the global Function", () => {
      expect(scanImportAllowlist(`obj.Function("x")\n`)).toEqual([]);
    });

    test("a bare `Function` type annotation (never called) is not flagged — it is TypeScript's own callback type", () => {
      expect(scanImportAllowlist(`let onClick: Function\n`)).toEqual([]);
    });

    test("`Function` as a generic type argument, uncalled, is not flagged (`Map<string, Function>`)", () => {
      expect(scanImportAllowlist(`let m: Map<string, Function>\n`)).toEqual([]);
    });

    test("a page defining a property/method literally named `eval` is flagged too — accepted over-approximation (§5.8)", () => {
      const errors = scanImportAllowlist(`const o = { eval() { return 1 } }\n`);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("Important 3 — evasions the token scanner knowingly cannot catch (pinned, not silently incomplete)", () => {
    test("KNOWN GAP: a bare Function reference aliased to a variable, then invoked through that variable", () => {
      // `Function` alone is legal (the type-annotation case above), so a bare
      // reference is deliberately not flagged; once it is only ever called
      // through a differently-named alias, no "Function"/"eval" token remains
      // anywhere near the call for a token scanner to catch.
      expect(scanImportAllowlist(`const F = Function\nnew F("a", "return a")\n`)).toEqual([]);
    });

    test('KNOWN GAP: a variable-mediated computed-member key (`const key = "eval"; g[key](...)`)', () => {
      // The computed-string check only matches a literal `"eval"`/`"Function"`
      // StringLiteral directly inside the brackets; once the string is held in
      // a variable first, the bracket contents are an Identifier, not a
      // literal, and the check does not follow the reference.
      expect(scanImportAllowlist(`const key = "eval"\nglobalThis[key]("x")\n`)).toEqual([]);
    });

    test("KNOWN GAP: the classic constructor-chain sandbox escape names neither `eval` nor `Function`", () => {
      // `[].constructor.constructor("return this")()` (here spelled with
      // computed access) reaches the Function constructor through two
      // `"constructor"` property reads and never writes the token "Function"
      // or "eval" anywhere — a token scanner has nothing to key off at all.
      expect(scanImportAllowlist(`[]["constructor"]["constructor"]("return this")()\n`)).toEqual(
        [],
      );
    });
  });

  describe("Important 1 (fix pass 2) — JSX children text is not scanned as code", () => {
    test("prose containing the bare word `eval` as a JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">Never use eval here</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose containing `Function (` as a JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">Function (beta)</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("the bare word `eval` as the WHOLE JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">eval</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test('a computed-access-shaped sentence (`globalThis["eval"]`) as JSX text is not fatally rejected', () => {
      const src = `export default () => <Text id="t">try globalThis["eval"]</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("a real eval(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{eval("1")}</Text>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real Function(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{Function("a", "return a")}</Text>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a real eval(...) call inside a JSX element nested within an expression container is still rejected", () => {
      const src = `export default () => <box>{cond && <text id="t">{eval("1")}</text>}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("prose in a JSX element nested inside an expression container is not fatally rejected", () => {
      const src = `export default () => <box>{cond && <text id="t">eval here</text>}</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose containing `eval` inside a bare Fragment (`<>...</>`) is not fatally rejected", () => {
      const src = `export default () => <>Never use eval here</>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("an uncalled generic type-argument list (`Array<Foo>`) does not mask a later real eval(...) call as JSX text", () => {
      // `scanOpenTag` alone treats `Array<Foo>` as a childless-looking open tag
      // (an accepted, narrow residual gap for `lintUnpointedElements`); this
      // pins that `computeJsxTextTokenIndices` does NOT inherit that gap, by
      // requiring a genuine matching close tag before trusting anything as
      // text — since no `</Foo>` ever appears, nothing here is masked.
      const src = `let xs: Array<Foo> = []\nconst z = eval("2")\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });
});

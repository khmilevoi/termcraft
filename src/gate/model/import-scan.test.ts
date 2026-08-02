import { describe, expect, test } from "bun:test";

import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";
import { readJsxTextRanges } from "./jsx";
import type { SourceStreamTruncatedError } from "./lexer";

/**
 * Unwraps `lexer.ts`'s completeness-invariant union at the test boundary (task-14 review round
 * 2, M6). A fixture whose token stream does not cover its source is a FIXTURE BUG, and it must
 * say so loudly here — silently reading as "no findings" is precisely the failure mode the
 * invariant exists to prevent, and a test suite that absorbed it would hide the next one.
 */
function scanned<T>(result: SourceStreamTruncatedError | T): T {
  if (result instanceof Error) {
    throw new Error(`fixture truncated the token stream: ${result.message}`);
  }
  return result;
}

const clean = `import { definePage, Panel, Text, atom, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "X", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{atom(1, "x")()}</Text></Panel>)
`;

const HAS = (relPath: string) => new Set(["lib/theme.ts", "widgets/gauge.tsx"]).has(relPath);
const ctx = {
  from: "pages/dashboard.tsx",
  has: HAS,
  isScanned: () => true,
  syntax: "jsx" as const,
};

/**
 * `context` is REQUIRED (Task 12: the one production caller that used to omit it,
 * `gate/model/gate.ts`'s `runGate`, no longer calls this function at all — the whole-tree
 * scan moved to `runTreeImports`/`scanTreeImports`, which always supplies a real, closure-backed
 * context). Every test below that is not itself exercising relative-import RESOLUTION only
 * needs *some* legal context to satisfy the signature — an honest empty tree, exactly what a
 * caller with nothing to resolve against would supply, never a fabricated one.
 *
 * `isScanned: () => true` is not a fabrication either, and specifically not a fail-open one: with
 * `has: () => false` no relative specifier ever RESOLVES, so the post-resolution question this
 * predicate answers is never reached. The two contexts above that do resolve
 * (`bothExist`/`onlyTs`) name files whose text those tests deliberately do not model, so the same
 * answer is the honest one there too — they exercise the resolver's probe order, not this scan's
 * "was it scanned" bar, which `tree-scan.test.ts` owns end to end.
 */
const NONE = { from: "", has: () => false, isScanned: () => true, syntax: "jsx" as const };

describe("scanImportAllowlist (§3.1 authoritative module-edge allowlist)", () => {
  test("a clean page importing only the bare runtime root passes", () => {
    expect(scanned(scanImportAllowlist(clean, NONE))).toEqual([]);
  });

  test("a type-only import from the runtime root is legal", () => {
    const errors = scanned(
      scanImportAllowlist(
        `import type { PageMeta } from "@termcraft/runtime"\nexport const x = 1\n`,
        NONE,
      ),
    );
    expect(errors).toEqual([]);
  });

  test("a value import from a foreign module is rejected", () => {
    const errors = scanned(scanImportAllowlist(`import { useState } from "react"\n`, NONE));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    expect(errors[0]?.message).toContain("react");
  });

  test("a type-only import from a foreign module is rejected (type edges are scanned)", () => {
    // `./local` is a syntactically LEGAL relative specifier (design §6) — against `NONE`'s
    // empty tree nothing can ever resolve, so the precise code is UNRESOLVED_IMPORT, not the
    // old blanket FORBIDDEN_IMPORT. See the context-aware describe block below for the
    // resolving case.
    const errors = scanned(scanImportAllowlist(`import type { X } from "./local"\n`, NONE));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
  });

  test("a runtime subpath is rejected (only the bare root is legal)", () => {
    const errors = scanned(
      scanImportAllowlist(`import { jsx } from "@termcraft/runtime/jsx-runtime"\n`, NONE),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a side-effect import is rejected even from the runtime root reasons aside — foreign is rejected", () => {
    // Same reason as the type-only case above: `./side-effect` is a legal relative shape that
    // simply cannot resolve against `NONE`'s empty tree, so it is UNRESOLVED_IMPORT now.
    expect(scanned(scanImportAllowlist(`import "./side-effect"\n`, NONE))[0]?.code).toBe(
      "UNRESOLVED_IMPORT",
    );
  });

  test("a dynamic import is rejected even when it names the runtime", () => {
    const errors = scanned(
      scanImportAllowlist(`const m = await import("@termcraft/runtime")\n`, NONE),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("DYNAMIC_IMPORT");
  });

  test("a re-export from the runtime is rejected (one page, no runtime-selected loading)", () => {
    const errors = scanned(
      scanImportAllowlist(`export { atom } from "@termcraft/runtime"\n`, NONE),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REEXPORT");
  });

  test("a bare re-export of a foreign module is rejected", () => {
    expect(scanned(scanImportAllowlist(`export * from "./other"\n`, NONE))[0]?.code).toBe(
      "REEXPORT",
    );
  });

  test("a CJS require is rejected", () => {
    const errors = scanned(scanImportAllowlist(`const react = require("react")\n`, NONE));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REQUIRE_CALL");
  });

  test("a local export is NOT a module edge (no false positive)", () => {
    expect(
      scanned(scanImportAllowlist(`export const label = "danger"\nexport default 1\n`, NONE)),
    ).toEqual([]);
  });

  test("import.meta is not a module edge", () => {
    expect(scanned(scanImportAllowlist(`const u = import.meta.url\n`, NONE))).toEqual([]);
  });

  test("a JSX string-attribute value is not mistaken for an import specifier", () => {
    const src = `import { Text } from "@termcraft/runtime"\nexport default () => <Text id="t" color="danger">hi "quoted"</Text>\n`;
    expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
  });

  test("reports every offending edge, not just the first", () => {
    const errors = scanned(
      scanImportAllowlist(`import "react"\nimport { x } from "lodash"\nrequire("fs")\n`, NONE),
    );
    expect(errors.length).toBe(3);
  });

  test("an eval(...) call is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanned(scanImportAllowlist(`const x = eval("1 + 1")\n`, NONE));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("EVAL_CALL");
    expect(errors[0]?.message).toContain("eval");
  });

  test("a new Function(...) construction is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanned(scanImportAllowlist(`const f = new Function("a", "return a")\n`, NONE));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FUNCTION_CALL");
    expect(errors[0]?.message).toContain("Function");
  });

  test("a method named eval on some object is not mistaken for the global eval", () => {
    expect(scanned(scanImportAllowlist(`obj.eval("x")\n`, NONE))).toEqual([]);
  });

  describe("Important 2 — optional chaining before eval is not a fatal false rejection", () => {
    test("obj?.eval(...) is not mistaken for the global eval", () => {
      expect(scanned(scanImportAllowlist(`obj?.eval("x")\n`, NONE))).toEqual([]);
    });
  });

  describe("Important 3 — eval/Function evasions the token scanner now catches", () => {
    test('a bare eval reference smuggled through the comma operator ((0, eval)("x")) is caught', () => {
      const errors = scanned(scanImportAllowlist(`(0, eval)("x")\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("an eval reference aliased to a variable then invoked later is caught at the point of reference", () => {
      const errors = scanned(scanImportAllowlist(`const e = eval\ne("x")\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a bare eval reference with no call at all is still caught (assignment alone reaches the capability)", () => {
      const errors = scanned(scanImportAllowlist(`const e = eval\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a computed-string eval access (globalThis["eval"](...)) is caught', () => {
      const errors = scanned(scanImportAllowlist(`globalThis["eval"]("x")\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a bare Function call without new (Function("a", "return a")(1)) is caught', () => {
      const errors = scanned(scanImportAllowlist(`Function("a", "return a")(1)\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('a computed-string Function access (g["Function"](...)) is caught', () => {
      const errors = scanned(scanImportAllowlist(`g["Function"]("a", "return a")\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a method named Function on some object is not mistaken for the global Function", () => {
      expect(scanned(scanImportAllowlist(`obj.Function("x")\n`, NONE))).toEqual([]);
    });

    test("a bare `Function` type annotation (never called) is not flagged — it is TypeScript's own callback type", () => {
      expect(scanned(scanImportAllowlist(`let onClick: Function\n`, NONE))).toEqual([]);
    });

    test("`Function` as a generic type argument, uncalled, is not flagged (`Map<string, Function>`)", () => {
      expect(scanned(scanImportAllowlist(`let m: Map<string, Function>\n`, NONE))).toEqual([]);
    });

    test("a page defining a property/method literally named `eval` is flagged too — accepted over-approximation (§5.8)", () => {
      const errors = scanned(scanImportAllowlist(`const o = { eval() { return 1 } }\n`, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a regex literal whose BODY spells `eval` is NOT flagged — the over-approximation is gone (task 14b)", () => {
      // BEHAVIOUR CHANGE, and it removes a FALSE POSITIVE rather than a catch: a regular
      // expression's body cannot execute anything, so flagging `/eval/` only ever rejected legal
      // code. It used to be flagged because `./lexer`'s `tokenize` never re-scanned `/` as a
      // regular expression, so the body was lexed as ordinary tokens and the word inside it read
      // as a bare `eval` reference. `tokenize` now goes through `./jsx`'s `scanCode` — the same
      // re-scan the JSX reader uses — which is what also closed KNOWN GAPS 6 and 6b below.
      expect(scanned(scanImportAllowlist(`const re = /eval/\n`, NONE))).toEqual([]);
      // …and a REAL call one character away is still caught, so the re-scan did not blind the
      // check. Without this companion, "never flag anything near a slash" would pass the line
      // above.
      const real = scanned(scanImportAllowlist(`const re = /x/\nconst v = eval("1")\n`, NONE));
      expect(real.map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });
  });

  describe("Important 3 — evasions the token scanner knowingly cannot catch (pinned, not silently incomplete)", () => {
    test("KNOWN GAP: a bare Function reference aliased to a variable, then invoked through that variable", () => {
      // `Function` alone is legal (the type-annotation case above), so a bare
      // reference is deliberately not flagged; once it is only ever called
      // through a differently-named alias, no "Function"/"eval" token remains
      // anywhere near the call for a token scanner to catch.
      expect(
        scanned(scanImportAllowlist(`const F = Function\nnew F("a", "return a")\n`, NONE)),
      ).toEqual([]);
    });

    test('KNOWN GAP: a variable-mediated computed-member key (`const key = "eval"; g[key](...)`)', () => {
      // The computed-string check only matches a literal `"eval"`/`"Function"`
      // StringLiteral directly inside the brackets; once the string is held in
      // a variable first, the bracket contents are an Identifier, not a
      // literal, and the check does not follow the reference.
      expect(
        scanned(scanImportAllowlist(`const key = "eval"\nglobalThis[key]("x")\n`, NONE)),
      ).toEqual([]);
    });

    test('KNOWN GAP: a concatenation-built computed-member key (`g["ev" + "al"](...)`)', () => {
      // Same reason as the variable-mediated key above, one step earlier: the
      // bracket holds two StringLiterals and a `+`, so neither one equals
      // "eval", and this scan folds no constants.
      expect(scanned(scanImportAllowlist(`globalThis["ev" + "al"]("x")\n`, NONE))).toEqual([]);
    });

    test("CLOSED (fix round 1): a regex in STATEMENT position after `)` no longer hides the call", () => {
      // `./jsx`'s reader still reads that `/` as division — telling statement from expression
      // position needs a parser — so the `}` in its character class still closes the container
      // early and the reader still calls the tail children text. What CHANGED is that being
      // called text no longer removes the span from the token stream: `tokenize` lexes it in a
      // bounded window and MARKS it, and `isAdjacentCall` keeps the one filter that remains from
      // hiding a real `eval(`. The boundary is still in the wrong place; the call is not.
      const src = `export default () => <box id="b">{(() => { if (x) /[}]/.test(s) })() + eval("2")}</box>\n`;
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("KNOWN GAP: the classic constructor-chain sandbox escape names neither `eval` nor `Function`", () => {
      // `[].constructor.constructor("return this")()` (here spelled with
      // computed access) reaches the Function constructor through two
      // `"constructor"` property reads and never writes the token "Function"
      // or "eval" anywhere — a token scanner has nothing to key off at all.
      expect(
        scanned(scanImportAllowlist(`[]["constructor"]["constructor"]("return this")()\n`, NONE)),
      ).toEqual([]);
    });
  });

  describe("Important 2 (fix pass 5) — the `<` half of that gap is CLOSED (task 14b); the `}` half is unreachable", () => {
    // `./jsx`'s `scanCode` used to read `/` as division after `)`, `<`, OR `}`.
    //
    // THE `<` HALF IS CLOSED. It was on that list because a re-lexed `</tag>` also puts a `/`
    // right after a `<`, but the two are distinguishable: a `<` reaching the reader's ordinary
    // path did so BECAUSE its predecessor ended an expression, i.e. it is a relational operator
    // and a regular expression may legally follow. `scanCode`'s `jsxPunctuation` parameter is
    // that distinction. Measured before the fix, through the real perimeter AND `await
    // import()`: `<box id="b">a{0 < /[}]/.test("s") && eval(...)}b</box>` transpiled, executed
    // its `eval`, and reported nothing.
    test("CLOSED: a regex literal right after `<` no longer closes the container early", () => {
      const src = `export default () => <box id="b">{x < /[}]/.test(s) && eval("1")}</box>\n`;
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("CLOSED, in the spelling Bun actually executes", () => {
      const src = `export const el = <box id="b">a{0 < /[}]/.test("}") && eval("1")}b</box>;\n`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("the valid-input companion: a genuine `a < b` comparison in a container is untouched", () => {
      // Without this, "flag everything after a `<`" would satisfy the two rows above, and every
      // page comparing two numbers inside a container would break.
      const src = `export const el = <box id="b">a{w < h && "small"}b</box>;\n`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("the `}` predecessor: Bun rejects the source outright, AND the call is caught anyway", () => {
      // The `}` exclusion stays in `scanCode`: a re-lexed `{expr} />` puts a `/` right after a
      // `}`, and unlike the `<` case there is no local signal separating that from real code.
      // It costs no live bypass, measured twice over — only a block or an object literal can put
      // a `}` immediately before a `/` in expression position and a JSX expression container
      // holds neither, so `Bun.Transpiler` refuses every spelling tried (`Unexpected }`); and
      // since fix round 1 the mis-placed text boundary no longer hides the call either.
      const src = `export default () => <box id="b">{ {} /[}]/.test(s) && eval("1")}</box>\n`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).toThrow();
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });
  });

  describe("KNOWN GAPS 6 and 6b are CLOSED (task 14b) — braces inside a regex body no longer desync tokenize()", () => {
    // These two lived in `./lexer`'s `tokenize` itself — the WHOLE-FILE token stream
    // `scanImportAllowlist` scans directly, no JSX involved — because `tokenize` never re-scanned
    // `/` as a regular expression, so a brace inside a character class desynchronised its
    // `{`/template stack and swallowed the rest of the file into unparsed template text.
    //
    // GAP 6b WAS MEASURED LIVE, not theoretical: `Bun.Transpiler` accepted the third fixture
    // below and `await import()` ran it, while the whole real perimeter reported NO violations.
    // "Documented gap" was the wrong verdict for it. `tokenize` now shares `./jsx`'s `scanCode`,
    // so the character class is inside one `RegularExpressionLiteral` token and the stack holds.
    test("CLOSED: a `}` inside a regex character class no longer resumes the template's tail early", () => {
      const src = 'const s = `${/[}]/ && eval("x")}`\n';
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("CLOSED: a `{` inside a regex character class no longer opens a fresh literal that swallows the file", () => {
      const src = 'const s = `${/[{]/.test(a)}`\nconst z = eval("2")\n';
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("CLOSED, and this is the executable spelling the reviewer measured through the real perimeter", () => {
      const src = 'const s = `${/[{]/.test("x")}`\nimport "node:fs"\neval("1")\n';
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(
        scanned(scanImportAllowlist(src, NONE))
          .map((e) => e.code)
          .sort(),
      ).toEqual(["EVAL_CALL", "FORBIDDEN_IMPORT"]);
    });

    test("the valid-input companion: an ordinary interpolated template still reports nothing", () => {
      // Without this, "flag everything near a backtick" would satisfy the three rows above.
      const src = "const s = `a${1}b${2}c`\nexport const t = s\n";
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("KNOWN GAP 7 is CLOSED (fix round 1): an unterminated template no longer swallows the file", () => {
      // No closing backtick exists anywhere in this source, so the resumed tail scan used to run
      // through end of file and absorb the real `eval` call into one token. `tokenize` now asks
      // the scanner's own `isUnterminated()` and, when it says yes, rewinds one character past
      // the opener and re-lexes the span — so the call is an ordinary token again.
      //
      // Bun still refuses THIS source (`Unterminated string literal`), so this exact spelling was
      // never a live bypass. The same swallow WAS reachable in files Bun accepts, through a
      // backtick that Bun reads as sitting inside a comment, which is what made closing it
      // necessary rather than tidy — see `lexer.test.ts`'s mechanism-3 block.
      const src = '<box id="b">{`${0}\nconst z = eval("2")\n';
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).toThrow();
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual(["EVAL_CALL"]);
    });

    test("…and an ordinary TERMINATED template is still one token — no findings invented", () => {
      // The valid-input companion: if the rewind fired on terminated literals too, a page whose
      // copy mentions `eval` inside a template string would be fatally rejected.
      const src = 'const s = `never write eval("x") in a page`\nexport const t = s\n';
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });
  });

  describe("Finding 4 (fix pass 5) — a namespaced attribute name no longer fatally rejects the element's own text", () => {
    test("a namespaced attribute keeps the element READABLE — its text no longer swallows the tag", () => {
      // The finding this row pins is about the ELEMENT being confirmed, not about the fatal:
      // before fix pass 5 a namespaced name failed the element, so its children were lexed as
      // ordinary code and the closing tag could be swallowed. The element is confirmed now.
      const src = `export default () => <box xml:lang="en" id="b">dynamic evaluation is banned</box>\n`;
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
      // …and the word itself is refused wherever it appears, which is fix round 2's trade.
      const withWord = `export default () => <box xml:lang="en" id="b">eval is banned</box>\n`;
      expect(scanned(scanImportAllowlist(withWord, NONE)).map((e) => e.code)).toEqual([
        "EVAL_CALL",
      ]);
    });
  });

  describe("Important 1 (fix pass 2) — JSX children text IS scanned as code (the fix-round-2 trade)", () => {
    /**
     * REVERSED DELIBERATELY in task 14b fix round 2, Critical 1. These rows used to assert that a
     * page's own display copy never trips §5.8. Three mechanisms were tried to make that true —
     * filtering marked tokens, skipping the spans in the lexer, then filtering only when a call
     * parenthesis was adjacent — and every one produced a FALSE NEGATIVE the moment the JSX
     * reader confirmed an element the runtime does not see. Measured live, all executed by Bun:
     * `eval ("1")`, `eval` + newline + `("1")`, a bare `eval`, `globalThis["eval"]` and
     * `new Function ("…")` reported nothing at all.
     *
     * So there is no suppression, and prose pays for it: display copy containing `eval`, or
     * `Function` before a `(`, is REFUSED and the author rephrases. Each row below pins that
     * trade AND the thing that makes it survivable — the prose still cannot swallow the code
     * after it, which is the boundary guarantee `./lexer`'s windows provide.
     */
    const proseRejected = (src: string, code: "EVAL_CALL" | "FUNCTION_CALL"): void => {
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual([code]);
    };
    test("prose containing the bare word `eval` IS rejected — the stated trade", () => {
      proseRejected(`export default () => <Text id="t">Never use eval here</Text>\n`, "EVAL_CALL");
    });

    test("prose containing `Function (` IS rejected — the stated trade", () => {
      proseRejected(`export default () => <Text id="t">Function (beta)</Text>\n`, "FUNCTION_CALL");
    });

    test("the bare word `eval` as the WHOLE JSX text child IS rejected", () => {
      proseRejected(`export default () => <Text id="t">eval</Text>\n`, "EVAL_CALL");
    });

    test('a computed-access-shaped sentence (`globalThis["eval"]`) as JSX text IS rejected', () => {
      proseRejected(
        `export default () => <Text id="t">try globalThis["eval"]</Text>\n`,
        "EVAL_CALL",
      );
    });

    test("a real eval(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{eval("1")}</Text>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real Function(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{Function("a", "return a")}</Text>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a real eval(...) call inside a JSX element nested within an expression container is still rejected", () => {
      const src = `export default () => <box>{cond && <text id="t">{eval("1")}</text>}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("prose in a JSX element nested inside an expression container IS rejected", () => {
      proseRejected(
        `export default () => <box>{cond && <text id="t">eval here</text>}</box>\n`,
        "EVAL_CALL",
      );
    });

    test("prose containing `eval` inside a bare Fragment (`<>...</>`) IS rejected", () => {
      proseRejected(`export default () => <>Never use eval here</>\n`, "EVAL_CALL");
    });

    test("…and prose WITHOUT those words is untouched — the trade is narrow, not a blanket", () => {
      // The valid-input companion the whole block needs: only the two banned words cost a page.
      for (const src of [
        `export default () => <Text id="t">Never use dynamic evaluation here</Text>\n`,
        `export default () => <Text id="t">it isn't allowed — don't try</Text>\n`,
        `export default () => <Text id="t">see the docs // for details</Text>\n`,
        `export default () => <Text id="t">#7ad7ff is the accent</Text>\n`,
      ]) {
        expect([src, scanned(scanImportAllowlist(src, NONE))]).toEqual([src, []]);
      }
    });

    test("an uncalled generic type-argument list (`Array<Foo>`) does not mask a later real eval(...) call as JSX text", () => {
      // `Array` — the identifier immediately before `<` — already ends a
      // primary expression (`endsExpression` in `./jsx`), so the reader never
      // even attempts `Foo` as a tag name and nothing here can be masked as
      // JSX text.
      const src = `let xs: Array<Foo> = []\nconst z = eval("2")\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("WP-6a fix-pass-3 — the code-token heuristic's unsound premise (§ finding)", () => {
    test("prose containing an apostrophe (`isn't`) does not swallow the closing tag", () => {
      // Before fix-pass-3: the apostrophe opens a code-mode string literal that
      // swallows the rest of the line INCLUDING `</Text>`, so the closing tag
      // never confirms and `eval` is read as a live reference again.
      // The word `eval` is deliberately NOT in this copy any more — fix round 2 flags it
      // wherever it appears — so the row measures the SWALLOW itself: the import written after
      // the element on the same line must still be seen.
      const src = `export default () => <Text id="t">it isn't allowed on this page</Text>; import "node:fs";\n`;
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual([
        "FORBIDDEN_IMPORT",
      ]);
    });

    test("prose containing an em dash and an apostrophe does not fatally reject the page", () => {
      // The apostrophe is the point of this row: before the JSX reader existed it opened a
      // string that swallowed the closing tag. It still must not.
      const src = `export default () => <Text id="t">rendering — don't stop</Text>\n`;
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("prose containing `//` does not open a line comment that swallows the closing tag", () => {
      // Before fix-pass-3: `//` opens a code-mode line comment that eats
      // `</Text>` the same way the apostrophe case eats it via a string.
      // Same shape as the apostrophe row above, and measured the same way: the import written
      // after the element on the same line must still be seen.
      const src = `export default () => <Text id="t">never // here</Text>; import "node:fs";\n`;
      expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual([
        "FORBIDDEN_IMPORT",
      ]);
    });

    test("a dangling close tag after an uncalled generic type argument does not launder a real eval(...) call as JSX text", () => {
      // A second, smaller hole from the same premise: the old heuristic read
      // `Array<Foo>` as a plausible childless open tag, and this LATER,
      // unrelated `</Foo>` — dangling, matching no real open tag — was accepted
      // as its matching close, laundering everything in between (including the
      // real `eval("2")`) into "JSX text" and returning no errors at all. The
      // reader closes it at the source: `endsExpression` (see the test above)
      // means `Foo` is never attempted as a tag, so nothing ever hunts for a
      // close tag to pair it with.
      const src = `let xs: Array<Foo> = []\nconst z = eval("2")\n</Foo>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("Critical 1 (fix pass 4) — a template literal or regex no longer hides dynamic code", () => {
    test("eval(...) after a template literal in a JSX expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+eval("x")}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("new Function(...) after a template literal in an expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+new Function("return 1")}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('globalThis["eval"](...) after a template literal in an expression container is caught', () => {
      const src = `export default () => <box id="b">{\`\${0}\`+globalThis["eval"]("x")}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) after a regex literal holding a `}` in an expression container is caught", () => {
      const src = `export default () => <box id="b">{/[}]/.test(s) ? eval("1") : 0}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) inside a template interpolation itself is caught", () => {
      const src = `export default () => <box id="b">{\`v=\${eval("1")}\`}</box>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("the mirror image: ordinary prose in a template literal's TAIL is not fatally rejected", () => {
      // Same root cause, opposite direction: before this pass the tail
      // `} eval is not allowed\`` was re-lexed as code, so a page describing
      // `eval` in an interpolated string was fatally rejected.
      expect(
        scanned(scanImportAllowlist("const s = `n=${1} eval is not allowed`\n", NONE)),
      ).toEqual([]);
    });
  });

  describe("Important 2 (fix pass 4) — spread attributes and dotted tag names keep prose readable", () => {
    test("prose in an element carrying a spread attribute is not fatally rejected", () => {
      const src = `export default () => <Text id="t" {...rest}>this isn't allowed on this page</Text>\n`;
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("prose in a member-expression tag (`<Kit.Text>`) is not fatally rejected", () => {
      const src = `export default () => <Kit.Text id="t">this isn't allowed</Kit.Text>\n`;
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("prose in an element whose attribute value is a template literal is not fatally rejected", () => {
      const src = `export default () => <box label={\`R\${n}\`}>this isn't allowed</box>\n`;
      expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
    });

    test("a real eval(...) inside a spread-attribute element's container is still caught", () => {
      const src = `export default () => <Text id="t" {...rest}>{eval("1")}</Text>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside a dotted-tag element's container is still caught", () => {
      const src = `export default () => <Kit.Text id="t">{eval("1")}</Kit.Text>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside the spread attribute's OWN expression is still caught", () => {
      const src = `export default () => <Text id="t" {...{ e: eval }}>prose</Text>\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a mismatched dotted close tag does not launder a real eval(...) call as JSX text", () => {
      const src = `export default () => <Kit.Text id="t">x</Kit.Other>\nconst z = eval("2")\n`;
      const errors = scanned(scanImportAllowlist(src, NONE));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });
});

describe("scanImportAllowlist — context-aware relative resolution (design §6, Task 11)", () => {
  test("a relative import that resolves inside the tree is accepted", () => {
    expect(scanned(scanImportAllowlist('import { theme } from "../lib/theme"\n', ctx))).toEqual([]);
    expect(scanned(scanImportAllowlist('import G from "../widgets/gauge.tsx"\n', ctx))).toEqual([]);
    expect(
      scanned(scanImportAllowlist('import { definePage } from "@termcraft/runtime"\n', ctx)),
    ).toEqual([]);
  });

  test("a relative import that does not resolve is UNRESOLVED_IMPORT with the resolver's reason", () => {
    const errors = scanned(scanImportAllowlist('import x from "../lib/missing"\n', ctx));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
    expect(errors[0]?.message).toContain("directory-index");
  });

  test("every §6 rejection is still fatal", () => {
    // Cast the expected-code column to the exported literal union rather than widening it to
    // `string` — a bare `string` beats `toBe`'s overload against `ImportScanError["code"]`.
    const cases: [string, ImportScanError["code"]][] = [
      ['import fs from "node:fs"\n', "FORBIDDEN_IMPORT"],
      ['import x from "react"\n', "FORBIDDEN_IMPORT"],
      ['import x from "@termcraft/runtime/ui"\n', "FORBIDDEN_IMPORT"],
      ['import x from "../../escape.ts"\n', "FORBIDDEN_IMPORT"],
      ['import x from "../lib/theme.ts?raw"\n', "FORBIDDEN_IMPORT"],
      ['const m = await import("../lib/theme")\n', "DYNAMIC_IMPORT"],
      ['export { theme } from "../lib/theme"\n', "REEXPORT"],
      ['const x = require("../lib/theme")\n', "REQUIRE_CALL"],
    ];
    for (const [source, code] of cases) {
      const errors = scanned(scanImportAllowlist(source, ctx));
      expect(errors[0]?.code).toBe(code);
    }
  });

  test("a type-only relative import is scanned exactly like a value import", () => {
    expect(scanned(scanImportAllowlist('import type { T } from "../lib/theme"\n', ctx))).toEqual(
      [],
    );
    expect(
      scanned(scanImportAllowlist('import type { T } from "../lib/nope"\n', ctx)),
    ).toHaveLength(1);
  });

  // --- adversarial coverage beyond the brief's own samples (Your Job, step 3) ---

  test("a specifier that resolves via the extension probe picks .tsx before .ts when both exist", () => {
    const bothExist = (relPath: string) =>
      new Set(["widgets/panel.tsx", "widgets/panel.ts"]).has(relPath);
    const errors = scanned(
      scanImportAllowlist('import P from "../widgets/panel"\n', {
        from: "pages/dashboard.tsx",
        syntax: "jsx",
        has: bothExist,
        isScanned: () => true,
      }),
    );
    expect(errors).toEqual([]);
  });

  test("a specifier resolves via the .ts fallback probe when no .tsx file exists", () => {
    const onlyTs = (relPath: string) => relPath === "lib/theme.ts";
    const errors = scanned(
      scanImportAllowlist('import t from "../lib/theme"\n', {
        from: "pages/dashboard.tsx",
        syntax: "jsx",
        has: onlyTs,
        isScanned: () => true,
      }),
    );
    expect(errors).toEqual([]);
  });

  test("a scoped bare package (@acme/widgets) is FORBIDDEN_IMPORT, not silently treated as relative", () => {
    const errors = scanned(scanImportAllowlist('import x from "@acme/widgets"\n', ctx));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("node:fs stays FORBIDDEN_IMPORT under a real tree context too, not only the context-less default", () => {
    const errors = scanned(scanImportAllowlist('import fs from "node:fs"\n', ctx));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a specifier that resolves to a file existing on real disk but absent from `has` is UNRESOLVED_IMPORT — the resolver trusts only `has`, never the real filesystem", () => {
    // "../package.json" from "pages/dashboard.tsx" normalizes to "package.json" — a file that
    // genuinely exists at this repo's root. `ctx.has` knows nothing about it, so if resolution
    // ever silently fell back to real disk I/O this would wrongly resolve; it must not.
    const errors = scanned(scanImportAllowlist('import pkg from "../package.json"\n', ctx));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
  });

  test("against NONE's honest-empty tree, only the bare runtime root stays legal", () => {
    expect(
      scanned(scanImportAllowlist('import { definePage } from "@termcraft/runtime"\n', NONE)),
    ).toEqual([]);
    expect(scanned(scanImportAllowlist('import x from "react"\n', NONE))[0]?.code).toBe(
      "FORBIDDEN_IMPORT",
    );
    // A specifier that stays inside NONE's empty `from: ""` root is UNRESOLVED_IMPORT —
    // nothing can resolve without a real tree, but the SHAPE is legal.
    expect(scanned(scanImportAllowlist('import x from "./lib/theme"\n', NONE))[0]?.code).toBe(
      "UNRESOLVED_IMPORT",
    );
    // A specifier that climbs ABOVE the empty root genuinely escapes it — honest
    // ESCAPES_TREE, mapped to FORBIDDEN_IMPORT, not a fabricated UNRESOLVED_IMPORT.
    expect(scanned(scanImportAllowlist('import x from "../lib/theme"\n', NONE))[0]?.code).toBe(
      "FORBIDDEN_IMPORT",
    );
  });

  describe("the rejection message is always the resolver's own — `context` is mandatory, so there is no separate no-context wording to keep honest", () => {
    test("a rejection's message carries the specifier, the resolver's `[code]` tag, and the real `from` it was scanned against", () => {
      const message = scanned(scanImportAllowlist('import x from "react"\n', ctx))[0]?.message;
      expect(message).toBeDefined();
      expect(message).toContain(ctx.from);
      expect(message).toContain("[BARE_SPECIFIER]");
    });
  });
});

/**
 * THE LEVEL PIN (task 14b). `tokenize` returns `SourceStreamTruncatedError | …`, and EVERY
 * consumer must propagate it rather than read it as "nothing found". Round 2 established the
 * pattern by mutation; task 14b re-ran that mutation at every level and found THREE that killed
 * nothing at all — this one among them, because a sibling reader in the same pipeline reported
 * the same file first and the end-to-end test was green for that reason instead.
 *
 * These tests take the level in ISOLATION, with no pipeline around it, so mutating exactly this
 * propagation reddens exactly these tests.
 *
 * THE FIXTURE IS DEEP JSX NESTING, and the reason is the shape of fix round 1. `tokenize` no
 * longer REFUSES anything: wherever it cannot classify a span it re-lexes it one character on,
 * so it always returns a stream that accounts for the whole source (that is what stopped real
 * code going invisible, and what removed the last false rejection). The fail-closed arm the
 * invariant names therefore lives at its one remaining, MEASURED cause — `./jsx`'s
 * recursive-descent reader exhausting the engine's stack, which THROWS. Each level below must
 * let that throw pass, not absorb it into an empty result; `scanTreeImports` and `runGate` are
 * the two places that convert it into `UNSCANNABLE_SOURCE`.
 */
const UNREADABLE = "<a>{".repeat(32_000);
const COVERED = `const a = 1;\n/* closed */\nimport fs from "node:fs"\n`;

describe("scanModuleEdges — a stream that does not cover the source is an ERROR, never an empty edge list", () => {
  test("lets the unreadable-source throw PASS rather than returning []", () => {
    // `[]` here is indistinguishable from "this file imports nothing", which is exactly the
    // silent "this page did not change" mode Task 13 exists to kill: the closure walk would
    // stop at this file and every page reaching it would report an unchanged closure hash.
    expect(() => scanModuleEdges(UNREADABLE, "jsx")).toThrow();
  });

  test("…and an ordinary source still returns its real edge, so this is not a blanket refusal", () => {
    expect(scanned(scanModuleEdges(COVERED, "jsx"))).toEqual(["node:fs"]);
  });
});

/**
 * IMPORTANT 4 of task 14b's review: spellings of design §5.8's banned capability that the
 * previous commit declared unclosable while never having tried. Each was measured live — Bun
 * accepts, `await import()` EXECUTES the payload, and the perimeter reported nothing — and each
 * needs neither alias tracking nor constant folding, so each is closed here.
 *
 * The valid-input companions matter as much as the catches: `Function` is also TypeScript's
 * built-in callback type, so a rule that flags it in type position rejects ordinary code.
 */
describe("KNOWN-GAP spellings closed in fix round 1 (Important 4)", () => {
  test("a PARENTHESISED `Function` reference that is then called is a call", () => {
    // The check used to require `(` as the very NEXT token, so one pair of parentheses walked
    // straight past it.
    for (const src of [
      `export const r = new (Function)("return 1")();\n`,
      `export const r = (Function)("return 1")();\n`,
      `export const r = (0, Function)("return 1")();\n`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        src,
        ["FUNCTION_CALL"],
      ]);
    }
  });

  test("`<global>.eval(...)` is the global eval, not a method on some other object", () => {
    // The check excluded EVERY `.`-prefixed occurrence, so the most obvious spelling of indirect
    // eval was never caught.
    for (const src of [
      `export const r = (globalThis as any).eval("1");\n`,
      `export const r = (window as any).eval("1");\n`,
      `export const r = (self as any).eval("1");\n`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        src,
        ["EVAL_CALL"],
      ]);
    }
  });

  test("the valid-input companions: `Function` in TYPE position is still not a call", () => {
    // Without these, "flag every `Function` next to a paren" would satisfy the rows above and
    // reject ordinary TypeScript.
    for (const src of [
      `export let m: Map<string, Function>;\n`,
      `export const f = (cb: Function): void => { void cb; };\n`,
      `export type H = (cb: Function) => void;\n`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE))]).toEqual([src, []]);
    }
  });

  test("the valid-input companion: an unrelated `.evaluate(...)` is untouched", () => {
    const src = `export const v = (globalThis as any).parser.evaluate();\n`;
    expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
  });

  test("KNOWN GAP, still open and now narrower: a DOUBLY parenthesised reference", () => {
    // Pinned rather than assumed away: following an arbitrary parenthesis nest is the
    // constant-folding job this scan does not do. Registered with gaps 1-4 in the plan's
    // red-debt ledger.
    const src = `export const r = ((Function))("return 1")();\n`;
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow();
    expect(scanned(scanImportAllowlist(src, NONE))).toEqual([]);
  });
});

/**
 * §5.8 OVER-APPROXIMATES UNIFORMLY (task 14b fix round 2, Critical 1). There is no prose
 * suppression: an `eval`/`Function` reference is flagged wherever it appears. These rows pin
 * BOTH directions of that trade, because a later round tempted to re-introduce a filter has to
 * break one of them to do it.
 */
describe("no prose suppression — the trade, in both directions", () => {
  /** Every spelling that a suppression rule was measured to let through. All executed by Bun. */
  const SPELLINGS: readonly (readonly [string, string, "EVAL_CALL" | "FUNCTION_CALL"])[] = [
    ["adjacent call", `export const r = eval("1");`, "EVAL_CALL"],
    ["space before paren", `export const r = eval ("1");`, "EVAL_CALL"],
    ["newline before paren", `export const r = eval\n("1");`, "EVAL_CALL"],
    ["bare reference", `export const e = eval;`, "EVAL_CALL"],
    ["computed access", `export const r = (globalThis as any)["eval"]("1");`, "EVAL_CALL"],
    ["global receiver", `export const r = (globalThis as any).eval("1");`, "EVAL_CALL"],
    ["Function with a space", `export const f = new Function ("return 1");`, "FUNCTION_CALL"],
    ["parenthesised Function", `export const f = (Function)("return 1");`, "FUNCTION_CALL"],
    ["unicode-escaped identifier", `export const r = ${"\\"}u0065val("1");`, "EVAL_CALL"],
  ];

  test("every spelling is caught in ORDINARY code", () => {
    for (const [name, body, code] of SPELLINGS) {
      const src = `${body}\n`;
      expect([name, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        name,
        [code],
      ]);
    }
  });

  test("…and every spelling is still caught inside a FICTIONAL prose run", () => {
    // The carrier makes the JSX reader confirm an element the runtime does not see, so the
    // payload sits in what the reader calls children text. Under every suppression rule this
    // branch tried, at least one of these spellings reported nothing while Bun executed it.
    for (const [name, body, code] of SPELLINGS) {
      const src = `let identity: <T>(x: T) => T = (x) => x;\n${body}\n// </T>\n`;
      expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
      expect(readJsxTextRanges(src).length).toBeGreaterThan(0);
      expect([name, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        name,
        [code],
      ]);
    }
  });

  test("the cost, pinned: display copy spelling those words is REFUSED", () => {
    // Stated as a test rather than only in prose, so nobody re-reads the trade as a defect.
    // The author's fix is a rephrase; `import-scan.ts`'s doc comment says so too.
    for (const [src, code] of [
      [`export default () => <Text id="t">Never use eval here</Text>\n`, "EVAL_CALL"],
      [`export default () => <Text id="t">Function (beta)</Text>\n`, "FUNCTION_CALL"],
    ] as const) {
      expect([src, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        src,
        [code],
      ]);
    }
  });

  test("…and the trade is NARROW: prose without those two words is untouched", () => {
    for (const src of [
      `export default () => <Text id="t">use dynamic evaluation sparingly</Text>\n`,
      `export default () => <Text id="t">it isn't allowed — don't try</Text>\n`,
      `export default () => <Text id="t">see the docs // for details</Text>\n`,
      `export default () => <Text id="t">a /* b and #7ad7ff</Text>\n`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE))]).toEqual([src, []]);
    }
  });
});

/**
 * The receiver arms of `isGlobalReceiver`, swept (task 14b fix round 2). `(globalThis as any).eval`
 * leaves a `)` before the dot and `globalThis.eval` leaves an IDENTIFIER, so the two exercise
 * different arms — and only the second consults the name list. `global` is not even an identifier
 * to the TypeScript scanner: it answers `GlobalKeyword`, the kind it uses for `declare global {}`,
 * which is its own third arm and was found by this sweep rather than by inspection.
 */
describe("every spelling of a global receiver reaches the global eval", () => {
  test("bare, parenthesised and keyword receivers are all recognised", () => {
    for (const src of [
      `export const r = globalThis.eval("1");
`,
      `export const r = window.eval("1");
`,
      `export const r = self.eval("1");
`,
      `export const r = global.eval("1");
`,
      `export const r = (globalThis as any).eval("1");
`,
      `export const r = (window as unknown as any).eval("1");
`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        src,
        ["EVAL_CALL"],
      ]);
    }
  });

  test("…and an ordinary object's method named `eval` is still not the global", () => {
    // The valid-input companion: without it, "flag every `.eval(`" would satisfy the row above.
    for (const src of [
      `export const r = obj.eval("x");
`,
      `export const r = obj?.eval("x");
`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE))]).toEqual([src, []]);
    }
  });
});

/**
 * LITERAL KEY SPELLINGS (task 14b fix round 3, Critical 2). Each of these writes the key in
 * exactly the form the computed-access check claimed to catch, and each missed it for one
 * token's worth of reason. All six were measured live: Bun accepts, `await import()` executes
 * the payload, and the perimeter reported only the import.
 */
describe("every LITERAL key spelling reaches the capability", () => {
  const CAUGHT: readonly (readonly [string, string, "EVAL_CALL" | "FUNCTION_CALL"])[] = [
    ["optional-chain index", `export const r = (globalThis as any)?.["eval"]("1");`, "EVAL_CALL"],
    [
      "optional-chain Function",
      `export const r = (globalThis as any)?.["Function"]("1")();`,
      "FUNCTION_CALL",
    ],
    ["template key", 'export const r = (globalThis as any)[`eval`]("1");', "EVAL_CALL"],
    ["destructured computed key", `const { ["eval"]: v } = globalThis as any;`, "EVAL_CALL"],
    ["destructured string key", `const { "eval": v } = globalThis as any;`, "EVAL_CALL"],
    ["Reflect.get", `export const r = Reflect.get(globalThis, "eval")("1");`, "EVAL_CALL"],
    ["plain bracket (control)", `export const r = (globalThis as any)["eval"]("1");`, "EVAL_CALL"],
  ];

  test("each one is a fatal, naming the right code", () => {
    for (const [name, body, code] of CAUGHT) {
      const src = `${body}
`;
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow();
      expect([name, scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)]).toEqual([
        name,
        [code],
      ]);
    }
  });

  test("the valid-input companions: the same shapes with any OTHER key are untouched", () => {
    // Without these, "flag every bracket, every template key and every Reflect.get" would
    // satisfy the row above and reject ordinary code.
    for (const src of [
      `export const v = (globalThis as any)?.["location"];
`,
      `export const o = { [\`id\`]: 1 };
`,
      `const { ["location"]: l } = globalThis as any;
export const v = l;
`,
      `const { "location": l } = globalThis as any;
export const v = l;
`,
      `export const v = Reflect.get(globalThis, "location");
`,
      `export const v = Reflect.ownKeys({});
`,
      `export const words = ["eval", "Function"];
`,
      `export const o2 = { onClick: 1, "data-id": 2 };
`,
    ]) {
      expect([src, scanned(scanImportAllowlist(src, NONE))]).toEqual([src, []]);
    }
  });
});

/**
 * THE UNION OF TWO READINGS (task 14b fix round 3, Critical 1). A window boundary landing inside
 * a genuine string literal flips this stream's quote parity against Bun's, and everything after
 * it becomes the interior of string tokens — with coverage accounting entirely satisfied.
 * Coverage is not visibility. Both scans therefore read the file twice, windowed and linear, and
 * union what they find.
 */
describe("the union restores what a mis-placed boundary hides", () => {
  /** Carriers whose fictional run ends inside the `"</T>"` literal on the following line. */
  const CARRIERS: readonly (readonly [string, string])[] = [
    ["type alias", `type X = <T extends unknown>(x: T) => T;`],
    ["generic arrow", `const f = <T extends unknown>(x: T) => x;`],
    ["annotation", `const g: <T>(x: T) => T = (x) => x;`],
    ["object-type method", `type O = { m: <T>(x: T) => T };`],
    ["as-cast", `const v = 1 as unknown as <T>(x: T) => T;`],
  ];

  const PAYLOADS: readonly (readonly [string, string, ImportScanError["code"]])[] = [
    ["forbidden import", `import "node:fs";`, "FORBIDDEN_IMPORT"],
    ["require", `const r = require("child_process");`, "REQUIRE_CALL"],
    ["dynamic import", `const p = import("node:fs");`, "DYNAMIC_IMPORT"],
    ["re-export", `export * from "node:fs";`, "REEXPORT"],
    ["eval", `const e = eval("1");`, "EVAL_CALL"],
    ["Function", `const f2 = new Function("return 1");`, "FUNCTION_CALL"],
  ];

  test("every carrier x payload is still reported, in a `.tsx` source", () => {
    for (const [carrierName, carrier] of CARRIERS) {
      for (const [payloadName, payload, code] of PAYLOADS) {
        const src = `${carrier}
const s = "</T>"; ${payload}
export const probe = 1;
`;
        expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(src)).not.toThrow();
        const codes = scanned(scanImportAllowlist(src, NONE)).map((e) => e.code);
        expect([carrierName, payloadName, codes.includes(code)]).toEqual([
          carrierName,
          payloadName,
          true,
        ]);
      }
    }
  });

  test("and the closure EDGE survives too — a lost edge is a file never scanned at all", () => {
    const src = `type X = <T extends unknown>(x: T) => T;
const s = "</T>"; import "./util";
export const probe = 1;
`;
    expect([...(scanned(scanModuleEdges(src, "jsx")) as readonly string[])]).toEqual(["./util"]);
  });

  test("the union does not duplicate a finding both readings see", () => {
    // Both readings agree on an ordinary source, and the report must not say it twice.
    const src = `export const T = () => <p>hi</p>;
import "node:fs";
`;
    expect(scanned(scanImportAllowlist(src, NONE)).map((e) => e.code)).toEqual([
      "FORBIDDEN_IMPORT",
    ]);
  });
});

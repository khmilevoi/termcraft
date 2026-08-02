import { describe, expect, test } from "bun:test";

import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist } from "./import-scan";

const clean = `import { definePage, Panel, Text, atom, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "X", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">{atom(1, "x")()}</Text></Panel>)
`;

const HAS = (relPath: string) => new Set(["lib/theme.ts", "widgets/gauge.tsx"]).has(relPath);
const ctx = { from: "pages/dashboard.tsx", has: HAS, isScanned: () => true };

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
const NONE = { from: "", has: () => false, isScanned: () => true };

describe("scanImportAllowlist (§3.1 authoritative module-edge allowlist)", () => {
  test("a clean page importing only the bare runtime root passes", () => {
    expect(scanImportAllowlist(clean, NONE)).toEqual([]);
  });

  test("a type-only import from the runtime root is legal", () => {
    const errors = scanImportAllowlist(
      `import type { PageMeta } from "@termcraft/runtime"\nexport const x = 1\n`,
      NONE,
    );
    expect(errors).toEqual([]);
  });

  test("a value import from a foreign module is rejected", () => {
    const errors = scanImportAllowlist(`import { useState } from "react"\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
    expect(errors[0]?.message).toContain("react");
  });

  test("a type-only import from a foreign module is rejected (type edges are scanned)", () => {
    // `./local` is a syntactically LEGAL relative specifier (design §6) — against `NONE`'s
    // empty tree nothing can ever resolve, so the precise code is UNRESOLVED_IMPORT, not the
    // old blanket FORBIDDEN_IMPORT. See the context-aware describe block below for the
    // resolving case.
    const errors = scanImportAllowlist(`import type { X } from "./local"\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
  });

  test("a runtime subpath is rejected (only the bare root is legal)", () => {
    const errors = scanImportAllowlist(
      `import { jsx } from "@termcraft/runtime/jsx-runtime"\n`,
      NONE,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a side-effect import is rejected even from the runtime root reasons aside — foreign is rejected", () => {
    // Same reason as the type-only case above: `./side-effect` is a legal relative shape that
    // simply cannot resolve against `NONE`'s empty tree, so it is UNRESOLVED_IMPORT now.
    expect(scanImportAllowlist(`import "./side-effect"\n`, NONE)[0]?.code).toBe(
      "UNRESOLVED_IMPORT",
    );
  });

  test("a dynamic import is rejected even when it names the runtime", () => {
    const errors = scanImportAllowlist(`const m = await import("@termcraft/runtime")\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("DYNAMIC_IMPORT");
  });

  test("a re-export from the runtime is rejected (one page, no runtime-selected loading)", () => {
    const errors = scanImportAllowlist(`export { atom } from "@termcraft/runtime"\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REEXPORT");
  });

  test("a bare re-export of a foreign module is rejected", () => {
    expect(scanImportAllowlist(`export * from "./other"\n`, NONE)[0]?.code).toBe("REEXPORT");
  });

  test("a CJS require is rejected", () => {
    const errors = scanImportAllowlist(`const react = require("react")\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REQUIRE_CALL");
  });

  test("a local export is NOT a module edge (no false positive)", () => {
    expect(scanImportAllowlist(`export const label = "danger"\nexport default 1\n`, NONE)).toEqual(
      [],
    );
  });

  test("import.meta is not a module edge", () => {
    expect(scanImportAllowlist(`const u = import.meta.url\n`, NONE)).toEqual([]);
  });

  test("a JSX string-attribute value is not mistaken for an import specifier", () => {
    const src = `import { Text } from "@termcraft/runtime"\nexport default () => <Text id="t" color="danger">hi "quoted"</Text>\n`;
    expect(scanImportAllowlist(src, NONE)).toEqual([]);
  });

  test("reports every offending edge, not just the first", () => {
    const errors = scanImportAllowlist(
      `import "react"\nimport { x } from "lodash"\nrequire("fs")\n`,
      NONE,
    );
    expect(errors.length).toBe(3);
  });

  test("an eval(...) call is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanImportAllowlist(`const x = eval("1 + 1")\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("EVAL_CALL");
    expect(errors[0]?.message).toContain("eval");
  });

  test("a new Function(...) construction is rejected as fatal dynamic code (§5.8)", () => {
    const errors = scanImportAllowlist(`const f = new Function("a", "return a")\n`, NONE);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FUNCTION_CALL");
    expect(errors[0]?.message).toContain("Function");
  });

  test("a method named eval on some object is not mistaken for the global eval", () => {
    expect(scanImportAllowlist(`obj.eval("x")\n`, NONE)).toEqual([]);
  });

  describe("Important 2 — optional chaining before eval is not a fatal false rejection", () => {
    test("obj?.eval(...) is not mistaken for the global eval", () => {
      expect(scanImportAllowlist(`obj?.eval("x")\n`, NONE)).toEqual([]);
    });
  });

  describe("Important 3 — eval/Function evasions the token scanner now catches", () => {
    test('a bare eval reference smuggled through the comma operator ((0, eval)("x")) is caught', () => {
      const errors = scanImportAllowlist(`(0, eval)("x")\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("an eval reference aliased to a variable then invoked later is caught at the point of reference", () => {
      const errors = scanImportAllowlist(`const e = eval\ne("x")\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a bare eval reference with no call at all is still caught (assignment alone reaches the capability)", () => {
      const errors = scanImportAllowlist(`const e = eval\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a computed-string eval access (globalThis["eval"](...)) is caught', () => {
      const errors = scanImportAllowlist(`globalThis["eval"]("x")\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test('a bare Function call without new (Function("a", "return a")(1)) is caught', () => {
      const errors = scanImportAllowlist(`Function("a", "return a")(1)\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('a computed-string Function access (g["Function"](...)) is caught', () => {
      const errors = scanImportAllowlist(`g["Function"]("a", "return a")\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a method named Function on some object is not mistaken for the global Function", () => {
      expect(scanImportAllowlist(`obj.Function("x")\n`, NONE)).toEqual([]);
    });

    test("a bare `Function` type annotation (never called) is not flagged — it is TypeScript's own callback type", () => {
      expect(scanImportAllowlist(`let onClick: Function\n`, NONE)).toEqual([]);
    });

    test("`Function` as a generic type argument, uncalled, is not flagged (`Map<string, Function>`)", () => {
      expect(scanImportAllowlist(`let m: Map<string, Function>\n`, NONE)).toEqual([]);
    });

    test("a page defining a property/method literally named `eval` is flagged too — accepted over-approximation (§5.8)", () => {
      const errors = scanImportAllowlist(`const o = { eval() { return 1 } }\n`, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a regex literal whose BODY spells `eval` is flagged too — accepted over-approximation", () => {
      // `./lexer`'s CODE-mode `tokenize` deliberately does not re-scan `/` as a
      // regular expression (it lexes JSX punctuation as code, where `</Text>`
      // and `{expr} />` would both be misread as regex openers), so a regex
      // body is lexed as ordinary tokens and the word inside it reads as a
      // bare `eval` reference.
      const errors = scanImportAllowlist(`const re = /eval/\n`, NONE);
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
      expect(scanImportAllowlist(`const F = Function\nnew F("a", "return a")\n`, NONE)).toEqual([]);
    });

    test('KNOWN GAP: a variable-mediated computed-member key (`const key = "eval"; g[key](...)`)', () => {
      // The computed-string check only matches a literal `"eval"`/`"Function"`
      // StringLiteral directly inside the brackets; once the string is held in
      // a variable first, the bracket contents are an Identifier, not a
      // literal, and the check does not follow the reference.
      expect(scanImportAllowlist(`const key = "eval"\nglobalThis[key]("x")\n`, NONE)).toEqual([]);
    });

    test('KNOWN GAP: a concatenation-built computed-member key (`g["ev" + "al"](...)`)', () => {
      // Same reason as the variable-mediated key above, one step earlier: the
      // bracket holds two StringLiterals and a `+`, so neither one equals
      // "eval", and this scan folds no constants.
      expect(scanImportAllowlist(`globalThis["ev" + "al"]("x")\n`, NONE)).toEqual([]);
    });

    test("KNOWN GAP: a regex literal in STATEMENT position after `)` closes an expression container early", () => {
      // `./jsx`'s reader decides regex-vs-division from the preceding token
      // (`endsExpression`): a `)` ends a primary expression, so `/` after it is
      // division everywhere an EXPRESSION can appear. Inside an arrow-function
      // body a statement-position regex is legal there anyway, and the `}` in
      // its character class then closes the container early, so everything
      // after it — here the real `eval("2")` — is mis-read as JSX children text.
      const src = `export default () => <box id="b">{(() => { if (x) /[}]/.test(s) })() + eval("2")}</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("KNOWN GAP: the classic constructor-chain sandbox escape names neither `eval` nor `Function`", () => {
      // `[].constructor.constructor("return this")()` (here spelled with
      // computed access) reaches the Function constructor through two
      // `"constructor"` property reads and never writes the token "Function"
      // or "eval" anywhere — a token scanner has nothing to key off at all.
      expect(
        scanImportAllowlist(`[]["constructor"]["constructor"]("return this")()\n`, NONE),
      ).toEqual([]);
    });
  });

  describe("Important 2 (fix pass 5) — the `<`/`}` regex-predecessor gap is reachable too, not just `)`", () => {
    // `./jsx`'s `scanCode` reads `/` as division after `)`, `<`, OR `}` — a
    // prior pass's comments claimed only `)` could actually hide a call. Both
    // of these hide a real `eval("1")` exactly the way the `)` KNOWN GAP test
    // above does; see `scanCode`'s own KNOWN GAP doc comment in `./jsx`.
    test("KNOWN GAP: a regex literal right after `<` closes an expression container early, hiding a real eval(...) call", () => {
      const src = `export default () => <box id="b">{x < /[}]/.test(s) && eval("1")}</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("KNOWN GAP: a regex literal right after `}` closes an expression container early, hiding a real eval(...) call", () => {
      const src = `export default () => <box id="b">{ {} /[}]/.test(s) && eval("1")}</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });
  });

  describe("Important 1 (fix pass 5) — braces inside a regex body defeat tokenize()'s own template tracking", () => {
    // A DIFFERENT, more fundamental layer than the two describe blocks above:
    // these gaps live in `./lexer`'s `tokenize` itself, the WHOLE-FILE token
    // stream `scanImportAllowlist` scans directly — no JSX involved at all in
    // the first two. `tokenize` never re-scans `/` as a regex (see
    // `scanCodeToken`'s own doc comment), so a brace inside a regex character
    // class desyncs its `{`/template brace-tracking stack.
    test("KNOWN GAP: a `}` inside a regex character class is misread as the enclosing template's own closing brace", () => {
      // The class's own `}` resumes the template's tail right there, so the
      // tail's literal text absorbs everything up to the next backtick —
      // including the real call.
      const src = 'const s = `${/[}]/ && eval("x")}`\n';
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("KNOWN GAP: a `{` inside a regex character class is pushed as a phantom brace, and the template's own closing backtick then opens a fresh, unterminated literal", () => {
      // The class's `{` is treated as an ordinary brace open; the
      // interpolation's real closing `}` only pops that phantom, so the
      // template's own genuine closing backtick right after it is re-lexed
      // from scratch as a brand-new literal with no matching close anywhere
      // else in the file — swallowing every later statement, including the
      // real `eval("2")`.
      const src = 'const s = `${/[{]/.test(a)}`\nconst z = eval("2")\n';
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("KNOWN GAP: the same desync through a genuinely unterminated template swallows the rest of the file, JSX included", () => {
      // No closing backtick exists anywhere in this source (it does not
      // compile) — the resumed tail scan runs straight through EOF, absorbing
      // everything after the opening backtick, the real `eval` call included,
      // into one token that is never split back apart.
      const src = '<box id="b">{`${0}\nconst z = eval("2")\n';
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });
  });

  describe("Finding 4 (fix pass 5) — a namespaced attribute name no longer fatally rejects the element's own text", () => {
    test('`<box xml:lang="en" id="b">eval is banned</box>` is legal JSX and is not fatally rejected', () => {
      const src = `export default () => <box xml:lang="en" id="b">eval is banned</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });
  });

  describe("Important 1 (fix pass 2) — JSX children text is not scanned as code", () => {
    test("prose containing the bare word `eval` as a JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">Never use eval here</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose containing `Function (` as a JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">Function (beta)</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("the bare word `eval` as the WHOLE JSX text child is not fatally rejected", () => {
      const src = `export default () => <Text id="t">eval</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test('a computed-access-shaped sentence (`globalThis["eval"]`) as JSX text is not fatally rejected', () => {
      const src = `export default () => <Text id="t">try globalThis["eval"]</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("a real eval(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{eval("1")}</Text>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real Function(...) call inside a JSX expression container is still rejected", () => {
      const src = `export default () => <Text id="t">{Function("a", "return a")}</Text>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test("a real eval(...) call inside a JSX element nested within an expression container is still rejected", () => {
      const src = `export default () => <box>{cond && <text id="t">{eval("1")}</text>}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("prose in a JSX element nested inside an expression container is not fatally rejected", () => {
      const src = `export default () => <box>{cond && <text id="t">eval here</text>}</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose containing `eval` inside a bare Fragment (`<>...</>`) is not fatally rejected", () => {
      const src = `export default () => <>Never use eval here</>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("an uncalled generic type-argument list (`Array<Foo>`) does not mask a later real eval(...) call as JSX text", () => {
      // `Array` — the identifier immediately before `<` — already ends a
      // primary expression (`endsExpression` in `./jsx`), so the reader never
      // even attempts `Foo` as a tag name and nothing here can be masked as
      // JSX text.
      const src = `let xs: Array<Foo> = []\nconst z = eval("2")\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("WP-6a fix-pass-3 — the code-token heuristic's unsound premise (§ finding)", () => {
    test("prose containing an apostrophe (`isn't`) does not swallow the closing tag and fatally reject the page", () => {
      // Before fix-pass-3: the apostrophe opens a code-mode string literal that
      // swallows the rest of the line INCLUDING `</Text>`, so the closing tag
      // never confirms and `eval` is read as a live reference again.
      const src = `export default () => <Text id="t">eval isn't allowed on this page</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose containing an em dash and an apostrophe (`eval — don't`) does not fatally reject the page", () => {
      const src = `export default () => <Text id="t">eval — don't</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose containing `//` does not open a code-mode line comment that swallows the closing tag", () => {
      // Before fix-pass-3: `//` opens a code-mode line comment that eats
      // `</Text>` the same way the apostrophe case eats it via a string.
      const src = `export default () => <Text id="t">eval // never</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
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
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("Critical 1 (fix pass 4) — a template literal or regex no longer hides dynamic code", () => {
    test("eval(...) after a template literal in a JSX expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+eval("x")}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("new Function(...) after a template literal in an expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+new Function("return 1")}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('globalThis["eval"](...) after a template literal in an expression container is caught', () => {
      const src = `export default () => <box id="b">{\`\${0}\`+globalThis["eval"]("x")}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) after a regex literal holding a `}` in an expression container is caught", () => {
      const src = `export default () => <box id="b">{/[}]/.test(s) ? eval("1") : 0}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) inside a template interpolation itself is caught", () => {
      const src = `export default () => <box id="b">{\`v=\${eval("1")}\`}</box>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("the mirror image: ordinary prose in a template literal's TAIL is not fatally rejected", () => {
      // Same root cause, opposite direction: before this pass the tail
      // `} eval is not allowed\`` was re-lexed as code, so a page describing
      // `eval` in an interpolated string was fatally rejected.
      expect(scanImportAllowlist("const s = `n=${1} eval is not allowed`\n", NONE)).toEqual([]);
    });
  });

  describe("Important 2 (fix pass 4) — spread attributes and dotted tag names keep prose readable", () => {
    test("prose in an element carrying a spread attribute is not fatally rejected", () => {
      const src = `export default () => <Text id="t" {...rest}>eval isn't allowed on this page</Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose in a member-expression tag (`<Kit.Text>`) is not fatally rejected", () => {
      const src = `export default () => <Kit.Text id="t">eval isn't allowed</Kit.Text>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("prose in an element whose attribute value is a template literal is not fatally rejected", () => {
      const src = `export default () => <box label={\`R\${n}\`}>eval isn't allowed</box>\n`;
      expect(scanImportAllowlist(src, NONE)).toEqual([]);
    });

    test("a real eval(...) inside a spread-attribute element's container is still caught", () => {
      const src = `export default () => <Text id="t" {...rest}>{eval("1")}</Text>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside a dotted-tag element's container is still caught", () => {
      const src = `export default () => <Kit.Text id="t">{eval("1")}</Kit.Text>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside the spread attribute's OWN expression is still caught", () => {
      const src = `export default () => <Text id="t" {...{ e: eval }}>prose</Text>\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a mismatched dotted close tag does not launder a real eval(...) call as JSX text", () => {
      const src = `export default () => <Kit.Text id="t">x</Kit.Other>\nconst z = eval("2")\n`;
      const errors = scanImportAllowlist(src, NONE);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });
});

describe("scanImportAllowlist — context-aware relative resolution (design §6, Task 11)", () => {
  test("a relative import that resolves inside the tree is accepted", () => {
    expect(scanImportAllowlist('import { theme } from "../lib/theme"\n', ctx)).toEqual([]);
    expect(scanImportAllowlist('import G from "../widgets/gauge.tsx"\n', ctx)).toEqual([]);
    expect(scanImportAllowlist('import { definePage } from "@termcraft/runtime"\n', ctx)).toEqual(
      [],
    );
  });

  test("a relative import that does not resolve is UNRESOLVED_IMPORT with the resolver's reason", () => {
    const errors = scanImportAllowlist('import x from "../lib/missing"\n', ctx);
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
      const errors = scanImportAllowlist(source, ctx);
      expect(errors[0]?.code).toBe(code);
    }
  });

  test("a type-only relative import is scanned exactly like a value import", () => {
    expect(scanImportAllowlist('import type { T } from "../lib/theme"\n', ctx)).toEqual([]);
    expect(scanImportAllowlist('import type { T } from "../lib/nope"\n', ctx)).toHaveLength(1);
  });

  // --- adversarial coverage beyond the brief's own samples (Your Job, step 3) ---

  test("a specifier that resolves via the extension probe picks .tsx before .ts when both exist", () => {
    const bothExist = (relPath: string) =>
      new Set(["widgets/panel.tsx", "widgets/panel.ts"]).has(relPath);
    const errors = scanImportAllowlist('import P from "../widgets/panel"\n', {
      from: "pages/dashboard.tsx",
      has: bothExist,
      isScanned: () => true,
    });
    expect(errors).toEqual([]);
  });

  test("a specifier resolves via the .ts fallback probe when no .tsx file exists", () => {
    const onlyTs = (relPath: string) => relPath === "lib/theme.ts";
    const errors = scanImportAllowlist('import t from "../lib/theme"\n', {
      from: "pages/dashboard.tsx",
      has: onlyTs,
      isScanned: () => true,
    });
    expect(errors).toEqual([]);
  });

  test("a scoped bare package (@acme/widgets) is FORBIDDEN_IMPORT, not silently treated as relative", () => {
    const errors = scanImportAllowlist('import x from "@acme/widgets"\n', ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("node:fs stays FORBIDDEN_IMPORT under a real tree context too, not only the context-less default", () => {
    const errors = scanImportAllowlist('import fs from "node:fs"\n', ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a specifier that resolves to a file existing on real disk but absent from `has` is UNRESOLVED_IMPORT — the resolver trusts only `has`, never the real filesystem", () => {
    // "../package.json" from "pages/dashboard.tsx" normalizes to "package.json" — a file that
    // genuinely exists at this repo's root. `ctx.has` knows nothing about it, so if resolution
    // ever silently fell back to real disk I/O this would wrongly resolve; it must not.
    const errors = scanImportAllowlist('import pkg from "../package.json"\n', ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("UNRESOLVED_IMPORT");
  });

  test("against NONE's honest-empty tree, only the bare runtime root stays legal", () => {
    expect(scanImportAllowlist('import { definePage } from "@termcraft/runtime"\n', NONE)).toEqual(
      [],
    );
    expect(scanImportAllowlist('import x from "react"\n', NONE)[0]?.code).toBe("FORBIDDEN_IMPORT");
    // A specifier that stays inside NONE's empty `from: ""` root is UNRESOLVED_IMPORT —
    // nothing can resolve without a real tree, but the SHAPE is legal.
    expect(scanImportAllowlist('import x from "./lib/theme"\n', NONE)[0]?.code).toBe(
      "UNRESOLVED_IMPORT",
    );
    // A specifier that climbs ABOVE the empty root genuinely escapes it — honest
    // ESCAPES_TREE, mapped to FORBIDDEN_IMPORT, not a fabricated UNRESOLVED_IMPORT.
    expect(scanImportAllowlist('import x from "../lib/theme"\n', NONE)[0]?.code).toBe(
      "FORBIDDEN_IMPORT",
    );
  });

  describe("the rejection message is always the resolver's own — `context` is mandatory, so there is no separate no-context wording to keep honest", () => {
    test("a rejection's message carries the specifier, the resolver's `[code]` tag, and the real `from` it was scanned against", () => {
      const message = scanImportAllowlist('import x from "react"\n', ctx)[0]?.message;
      expect(message).toBeDefined();
      expect(message).toContain(ctx.from);
      expect(message).toContain("[BARE_SPECIFIER]");
    });
  });
});

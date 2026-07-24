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

    test("a regex literal whose BODY spells `eval` is flagged too — accepted over-approximation", () => {
      // `./lexer`'s CODE-mode `tokenize` deliberately does not re-scan `/` as a
      // regular expression (it lexes JSX punctuation as code, where `</Text>`
      // and `{expr} />` would both be misread as regex openers), so a regex
      // body is lexed as ordinary tokens and the word inside it reads as a
      // bare `eval` reference.
      const errors = scanImportAllowlist(`const re = /eval/\n`);
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

    test('KNOWN GAP: a concatenation-built computed-member key (`g["ev" + "al"](...)`)', () => {
      // Same reason as the variable-mediated key above, one step earlier: the
      // bracket holds two StringLiterals and a `+`, so neither one equals
      // "eval", and this scan folds no constants.
      expect(scanImportAllowlist(`globalThis["ev" + "al"]("x")\n`)).toEqual([]);
    });

    test("KNOWN GAP: a regex literal in STATEMENT position after `)` closes an expression container early", () => {
      // `./jsx`'s reader decides regex-vs-division from the preceding token
      // (`endsExpression`): a `)` ends a primary expression, so `/` after it is
      // division everywhere an EXPRESSION can appear. Inside an arrow-function
      // body a statement-position regex is legal there anyway, and the `}` in
      // its character class then closes the container early, so everything
      // after it — here the real `eval("2")` — is mis-read as JSX children text.
      const src = `export default () => <box id="b">{(() => { if (x) /[}]/.test(s) })() + eval("2")}</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
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

  describe("Important 2 (fix pass 5) — the `<`/`}` regex-predecessor gap is reachable too, not just `)`", () => {
    // `./jsx`'s `scanCode` reads `/` as division after `)`, `<`, OR `}` — a
    // prior pass's comments claimed only `)` could actually hide a call. Both
    // of these hide a real `eval("1")` exactly the way the `)` KNOWN GAP test
    // above does; see `scanCode`'s own KNOWN GAP doc comment in `./jsx`.
    test("KNOWN GAP: a regex literal right after `<` closes an expression container early, hiding a real eval(...) call", () => {
      const src = `export default () => <box id="b">{x < /[}]/.test(s) && eval("1")}</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("KNOWN GAP: a regex literal right after `}` closes an expression container early, hiding a real eval(...) call", () => {
      const src = `export default () => <box id="b">{ {} /[}]/.test(s) && eval("1")}</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
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
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("KNOWN GAP: a `{` inside a regex character class is pushed as a phantom brace, and the template's own closing backtick then opens a fresh, unterminated literal", () => {
      // The class's `{` is treated as an ordinary brace open; the
      // interpolation's real closing `}` only pops that phantom, so the
      // template's own genuine closing backtick right after it is re-lexed
      // from scratch as a brand-new literal with no matching close anywhere
      // else in the file — swallowing every later statement, including the
      // real `eval("2")`.
      const src = 'const s = `${/[{]/.test(a)}`\nconst z = eval("2")\n';
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("KNOWN GAP: the same desync through a genuinely unterminated template swallows the rest of the file, JSX included", () => {
      // No closing backtick exists anywhere in this source (it does not
      // compile) — the resumed tail scan runs straight through EOF, absorbing
      // everything after the opening backtick, the real `eval` call included,
      // into one token that is never split back apart.
      const src = '<box id="b">{`${0}\nconst z = eval("2")\n';
      expect(scanImportAllowlist(src)).toEqual([]);
    });
  });

  describe("Finding 4 (fix pass 5) — a namespaced attribute name no longer fatally rejects the element's own text", () => {
    test('`<box xml:lang="en" id="b">eval is banned</box>` is legal JSX and is not fatally rejected', () => {
      const src = `export default () => <box xml:lang="en" id="b">eval is banned</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
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
      // `Array` — the identifier immediately before `<` — already ends a
      // primary expression (`endsExpression` in `./jsx`), so the reader never
      // even attempts `Foo` as a tag name and nothing here can be masked as
      // JSX text.
      const src = `let xs: Array<Foo> = []\nconst z = eval("2")\n`;
      const errors = scanImportAllowlist(src);
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
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose containing an em dash and an apostrophe (`eval — don't`) does not fatally reject the page", () => {
      const src = `export default () => <Text id="t">eval — don't</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose containing `//` does not open a code-mode line comment that swallows the closing tag", () => {
      // Before fix-pass-3: `//` opens a code-mode line comment that eats
      // `</Text>` the same way the apostrophe case eats it via a string.
      const src = `export default () => <Text id="t">eval // never</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
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
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });

  describe("Critical 1 (fix pass 4) — a template literal or regex no longer hides dynamic code", () => {
    test("eval(...) after a template literal in a JSX expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+eval("x")}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("new Function(...) after a template literal in an expression container is caught", () => {
      const src = `export default () => <box id="b">{\`\${0}\`+new Function("return 1")}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("FUNCTION_CALL");
    });

    test('globalThis["eval"](...) after a template literal in an expression container is caught', () => {
      const src = `export default () => <box id="b">{\`\${0}\`+globalThis["eval"]("x")}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) after a regex literal holding a `}` in an expression container is caught", () => {
      const src = `export default () => <box id="b">{/[}]/.test(s) ? eval("1") : 0}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("eval(...) inside a template interpolation itself is caught", () => {
      const src = `export default () => <box id="b">{\`v=\${eval("1")}\`}</box>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("the mirror image: ordinary prose in a template literal's TAIL is not fatally rejected", () => {
      // Same root cause, opposite direction: before this pass the tail
      // `} eval is not allowed\`` was re-lexed as code, so a page describing
      // `eval` in an interpolated string was fatally rejected.
      expect(scanImportAllowlist("const s = `n=${1} eval is not allowed`\n")).toEqual([]);
    });
  });

  describe("Important 2 (fix pass 4) — spread attributes and dotted tag names keep prose readable", () => {
    test("prose in an element carrying a spread attribute is not fatally rejected", () => {
      const src = `export default () => <Text id="t" {...rest}>eval isn't allowed on this page</Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose in a member-expression tag (`<Kit.Text>`) is not fatally rejected", () => {
      const src = `export default () => <Kit.Text id="t">eval isn't allowed</Kit.Text>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("prose in an element whose attribute value is a template literal is not fatally rejected", () => {
      const src = `export default () => <box label={\`R\${n}\`}>eval isn't allowed</box>\n`;
      expect(scanImportAllowlist(src)).toEqual([]);
    });

    test("a real eval(...) inside a spread-attribute element's container is still caught", () => {
      const src = `export default () => <Text id="t" {...rest}>{eval("1")}</Text>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside a dotted-tag element's container is still caught", () => {
      const src = `export default () => <Kit.Text id="t">{eval("1")}</Kit.Text>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a real eval(...) inside the spread attribute's OWN expression is still caught", () => {
      const src = `export default () => <Text id="t" {...{ e: eval }}>prose</Text>\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });

    test("a mismatched dotted close tag does not launder a real eval(...) call as JSX text", () => {
      const src = `export default () => <Kit.Text id="t">x</Kit.Other>\nconst z = eval("2")\n`;
      const errors = scanImportAllowlist(src);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("EVAL_CALL");
    });
  });
});

import { describe, expect, test } from "bun:test";

import { scanNamedExports } from "./exports-scan";

const names = (source: string, syntax: "jsx" | "no-jsx" = "no-jsx") => {
  const result = scanNamedExports(source, syntax);
  expect(result).not.toBeInstanceOf(Error);
  if (result instanceof Error) return { names: new Set<string>(), exhaustive: true };
  return { names: result.names, exhaustive: result.exhaustive };
};

describe("scanNamedExports", () => {
  test.each([
    ["export const Button = 1", "Button"],
    ["export let Button = 1", "Button"],
    ["export var Button = 1", "Button"],
    ["export function Button() {}", "Button"],
    ["export async function Button() {}", "Button"],
    ["export function* Button() {}", "Button"],
    ["export class Button {}", "Button"],
    ["export abstract class Button {}", "Button"],
    ["export { Button }", "Button"],
    ["const B = 1; export { B as Button }", "Button"],
    ["export interface Button {}", "Button"],
    ["export type Button = 1", "Button"],
  ])("%s exports Button", (source, expected) => {
    const result = names(source);
    expect(result.names.has(expected)).toBe(true);
    expect(result.exhaustive).toBe(true);
  });

  test("a multi-declarator export names every binding", () => {
    const result = names("export const A = 1, Button = 2, C = 3");
    expect([...result.names].sort()).toEqual(["A", "Button", "C"]);
  });

  test("an export clause names every binding", () => {
    const result = names("const a = 1, b = 2; export { a as Button, b }");
    expect([...result.names].sort()).toEqual(["Button", "b"]);
  });

  test.each([
    "const Button = 1", // not exported
    "export default function Button() {}", // default, not a named binding
    "function outer() { const Button = 1; return Button }",
    "// export const Button = 1",
    `const s = "export const Button = 1"`,
  ])("%s does not name Button", (source) => {
    expect(names(source).names.has("Button")).toBe(false);
  });

  test("a destructuring export makes the scan non-exhaustive", () => {
    const result = names("export const { Button } = kit");
    expect(result.exhaustive).toBe(false);
  });

  test("an array destructuring export makes the scan non-exhaustive", () => {
    expect(names("export const [Button] = kit").exhaustive).toBe(false);
  });

  test("a star re-export makes the scan non-exhaustive", () => {
    expect(names(`export * from "./kit"`).exhaustive).toBe(false);
  });

  test("a named re-export still names its bindings", () => {
    // `export { X } from "./y"` is itself a FORBIDDEN form the import allowlist already rejects
    // under REEXPORT; this scan simply reports what it sees and does not re-litigate that.
    expect(names(`export { Button } from "./kit"`).names.has("Button")).toBe(true);
  });

  test("a JSX source is read with the JSX reader", () => {
    const result = names(`export const Button = () => <box id="b" />`, "jsx");
    expect(result.names.has("Button")).toBe(true);
  });

  test("a truncated stream is returned as a value, never thrown", () => {
    const result = scanNamedExports("const s = 'unterminated", "no-jsx");
    // Either a SourceStreamTruncatedError or a clean scan is acceptable; a THROW is not.
    expect(() => scanNamedExports("const s = 'unterminated", "no-jsx")).not.toThrow();
    expect(result === null).toBe(false);
  });
});

// Fix round 2 (task review Important findings, superseding round 1's fail-open pre-check): a
// bare `function`/`class`/`async` keyword in a declarator's own initializer is now SKIPPED PAST
// — not treated as ending the declarator list — so the walk keeps collecting every real name.
// Round 1's pre-check only guarded the FIRST declarator, which the round-2 review measured as
// both over-firing (a single declarator with nothing to lose still went non-exhaustive) and
// under-firing (a bare keyword on a later, non-final declarator still lost the name after it).
// (Fix round 4 replaced the mechanism — `function`/`class`/`async` are now just three more
// `DECLARATION_STARTS` members read through via `isStatementPosition`, with no dedicated skip
// function — but every outcome this block pins is unchanged; see `scanNamedExports`'s doc
// comment for the current rule set.)
describe("scanNamedExports — declarator initializer edge cases (fix round 2)", () => {
  test.each([
    "export const a = function () {}, b = 2",
    "export const a = function foo() {}, b = 2",
    "export const a = function* () {}, b = 2",
    "export const a = async function () {}, b = 2",
    "export const a = class {}, b = 2",
    "export const a = class Foo extends Bar {}, b = 2",
    "export const a = async () => 1, b = 2",
    "export const a = async () => { return 1 }, b = 2",
    "export var a = function () {}, b = 2",
  ])("%s still names both bindings and stays exhaustive", (source) => {
    const result = names(source);
    expect([...result.names].sort()).toEqual(["a", "b"]);
    expect(result.exhaustive).toBe(true);
  });

  test("a bare keyword on a later, non-final declarator no longer loses the name after it", () => {
    const result = names("export const a = 1, b = function(){}, c = 2");
    expect([...result.names].sort()).toEqual(["a", "b", "c"]);
    expect(result.exhaustive).toBe(true);
  });

  test.each([
    "export const a = function () {}",
    "export const a = class {}",
    "export const a = async () => 1",
    "export const Button = function Button() {}",
  ])("%s names its single binding and stays exhaustive (no sibling to lose)", (source) => {
    const result = names(source);
    expect(result.exhaustive).toBe(true);
    expect(result.names.size).toBe(1);
  });

  // Regression guards carried over from round 1 — shapes that were already safe and must stay so.
  test.each([
    "export const a = 1, b = function(){}",
    "export const a = (function () {})(), b = 2",
    "export const a = { const: 1 }, b = 2",
    "export const a = () => { const x = function(){}; return x }, b = 2",
  ])("%s still names both bindings and stays exhaustive (regression guard)", (source) => {
    const result = names(source);
    expect([...result.names].sort()).toEqual(["a", "b"]);
    expect(result.exhaustive).toBe(true);
  });

  test.each([
    "export const { Button } = kit",
    "export const [Button] = kit",
    `export * from "./kit"`,
  ])("%s stays non-exhaustive (regression guard)", (source) => {
    expect(names(source).exhaustive).toBe(false);
  });

  test("a truncated function initializer is returned as a value and does not claim exhaustiveness", () => {
    const result = scanNamedExports("export const a = function () {", "no-jsx");
    expect(() => scanNamedExports("export const a = function () {", "no-jsx")).not.toThrow();
    expect(result === null).toBe(false);
    if (result instanceof Error) return;
    expect(result.exhaustive).toBe(false);
  });
});

// Fix round 3 (task review Critical finding): a template literal's interpolation is opaque to
// the lexer's brace/paren/bracket tokens (`TemplateHead`/`TemplateMiddle`/`TemplateTail`, never
// `OpenBraceToken`/`CloseBraceToken`), and the declarator walk's `CommaToken` branch used to jump
// blindly past whatever followed a comma. Combined, a comma or `import` sitting at an
// interpolation's own top level could end the walk silently (dropping a real declarator name) or
// get mistaken for a declarator name that was never exported. See `skipTemplateLiteral`'s doc
// comment for the full mechanism.
describe("scanNamedExports — template-interpolation edge cases (fix round 3)", () => {
  test.each([
    'export const a = `${x, (import("mod"))}`, b = 2',
    "export const a = `${x, (import.meta.url)}`, b = 2",
  ])("%s no longer loses `b` to a comma or `import` inside the interpolation", (source) => {
    const result = names(source);
    expect([...result.names].sort()).toEqual(["a", "b"]);
    expect(result.exhaustive).toBe(true);
  });

  test('export const a = 1, m = `${x, (import("y"))}`, c = 3 no longer loses `c`', () => {
    const result = names('export const a = 1, m = `${x, (import("y"))}`, c = 3');
    expect([...result.names].sort()).toEqual(["a", "c", "m"]);
    expect(result.exhaustive).toBe(true);
  });

  test("a comma inside an interpolation no longer invents a phantom export", () => {
    const result = names("export const a = `${x, y}`, b = 2");
    expect([...result.names].sort()).toEqual(["a", "b"]);
    expect(result.names.has("y")).toBe(false);
    expect(result.exhaustive).toBe(true);
  });

  test.each([
    ["export const a = `${x}`, b = 2", ["a", "b"]],
    ["export const p = `${fn(a, b)}`, q = 2", ["p", "q"]],
    ["export const a = `${`${b}`}`, c = 2", ["a", "c"]],
    ['export const a = `${ "}" }`, b = 2', ["a", "b"]],
  ])("%s treats the whole template as opaque and stays exhaustive", (source, expected) => {
    const result = names(source);
    expect([...result.names].sort()).toEqual(expected);
    expect(result.exhaustive).toBe(true);
  });

  test("an unterminated template is returned as a value and does not claim exhaustiveness", () => {
    const source = "export const a = `${x";
    expect(() => scanNamedExports(source, "no-jsx")).not.toThrow();
    const result = scanNamedExports(source, "no-jsx");
    expect(result === null).toBe(false);
    if (result instanceof Error) return;
    expect(result.exhaustive).toBe(false);
  });

  // Controls re-verified against this round's changes — must stay exactly as safe as before.
  test.each([
    ['export const a = (import("mod")), b = 2', ["a", "b"]],
    ["export const a = { const: 1 }, b = 2", ["a", "b"]],
    ["export const a = (function () {})(), b = 2", ["a", "b"]],
  ])("%s is unaffected (control)", (source, expected) => {
    const result = names(source);
    expect([...result.names].sort()).toEqual(expected);
    expect(result.exhaustive).toBe(true);
  });
});

// Fix round 4 (task review Critical findings A and B — a full rewrite of the declarator-list
// walk's decision rules, replacing kind-only pattern matching with position-proven decisions).
//
// CRITICAL A: `<`/`>` are outside the walk's bracket alphabet — a token walk cannot tell a
// generic type-argument list from the less-than operator (`a < b, c > d` is a valid comparison),
// so a comma between generic arguments sat at the walk's own top level and was read as a
// declarator separator, INVENTING a phantom name from whatever followed it. `new Map<string, T>()`
// is everyday code, so this fired on ordinary files.
//
// CRITICAL B: `endsDeclaratorList` matched a `DECLARATION_STARTS` member (or `export`/`import`)
// by KIND ALONE, with no check on WHERE it sat — but every one of those keywords is ALSO legal
// mid-expression (a property name after `.`, the right side of `as`, the callee of a dynamic
// `import(...)`), so using one that way was mistaken for the start of a new statement, silently
// DROPPING every real declarator after it.
//
// The fix inverts the walk: nothing ends the list, or is read as an opaque unit, unless the walk
// can PROVE it from the token's own kind or its PROVEN position (`isStatementPosition`, using
// Automatic Semicolon Insertion's own rules). See `scanNamedExports`'s doc comment for the full
// rule set.
describe("scanNamedExports — position-proven declarator boundaries (fix round 4)", () => {
  describe("Critical A: a `<` never invents a name", () => {
    test("new Map<string, ComponentSpec>() does not invent ComponentSpec", () => {
      const result = names("export const registry = new Map<string, ComponentSpec>();");
      expect(result.names.has("registry")).toBe(true);
      expect(result.names.has("ComponentSpec")).toBe(false);
    });

    test("a Record<string, Comp> type annotation does not invent Comp", () => {
      const result = names("export const cache: Record<string, Comp> = {}");
      expect(result.names.has("cache")).toBe(true);
      expect(result.names.has("Comp")).toBe(false);
    });

    test("a nested Promise<Result<A, B>> type annotation does not invent B", () => {
      const result = names("export const p: Promise<Result<A, B>> = q");
      expect(result.names.has("p")).toBe(true);
      expect(result.names.has("B")).toBe(false);
    });

    test("a generic call pick<A, B>(x) does not invent B", () => {
      const result = names("export const v = pick<A, B>(x), w = 2");
      expect(result.names.has("v")).toBe(true);
      expect(result.names.has("B")).toBe(false);
    });

    test("an `as` cast to Map<Foo, Bar> does not invent Bar", () => {
      const result = names("export const a = x as Map<Foo, Bar>, b = 2");
      expect(result.names.has("a")).toBe(true);
      expect(result.names.has("Bar")).toBe(false);
    });

    test("a generic arrow <T, U>(...) does not invent U", () => {
      const result = names("export const f = <T, U>(a: T, b: U) => a");
      expect(result.names.has("f")).toBe(true);
      expect(result.names.has("U")).toBe(false);
    });

    test.each([
      "export const registry = new Map<string, ComponentSpec>();",
      "export const cache: Record<string, Comp> = {}",
      "export const p: Promise<Result<A, B>> = q",
      "export const v = pick<A, B>(x), w = 2",
      "export const a = x as Map<Foo, Bar>, b = 2",
      "export const f = <T, U>(a: T, b: U) => a",
    ])("%s reports exhaustive: false rather than guess past the `<`", (source) => {
      expect(names(source).exhaustive).toBe(false);
    });
  });

  describe("Critical B: a contextual keyword mid-expression no longer loses a name", () => {
    test('`as const` on an object literal does not end the list at its own "const"', () => {
      const result = names('export const theme = { bg: "#000" } as const, radius = 2');
      expect([...result.names].sort()).toEqual(["radius", "theme"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a bare import(...) call does not end the list at `import`", () => {
      const result = names('export const a = import("x"), b = 2');
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("`await import(...)` does not end the list at `import`", () => {
      const result = names('export const a = await import("x"), b = 2');
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    // The brief's own list of contextual keywords used as a property name after `.`.
    test.each([
      "type",
      "module",
      "namespace",
      "interface",
      "enum",
      "let",
      "var",
      "abstract",
      "import",
      "export",
    ])("a property access `props.%s` does not end the list", (keyword) => {
      const result = names(`export const a = props.${keyword}, b = 2`);
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    // Beyond the brief's list: the fix is purely position-based, so it must generalize to every
    // `DECLARATION_STARTS`/`export`/`import` member uniformly, including the fully-reserved ones
    // (`const`, `class`, `function`) that were never in any prior round's repro set.
    test.each(["const", "class", "function", "async"])(
      "a property access `props.%s` (not in the brief's list) also does not end the list",
      (keyword) => {
        const result = names(`export const a = props.${keyword}, b = 2`);
        expect([...result.names].sort()).toEqual(["a", "b"]);
        expect(result.exhaustive).toBe(true);
      },
    );
  });

  // Required by the task brief: ASI is what makes a semicolon-less, multi-statement file (this
  // project's own style) work at all — without it, the token right after a declarator's own
  // value would need to match `;`/`}` exactly to end the list, and a file written the way this
  // repository writes files (no semicolons) would either terminate wrongly or fail open on every
  // single file.
  describe("multi-statement files (ASI)", () => {
    test("two semicolon-less export statements on separate lines both contribute", () => {
      const result = names("export const a = 1\nexport const b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("an import plus two semicolon-less exports all resolve correctly", () => {
      const result = names(
        'import { x } from "./x"\nexport const registry = new Map()\nexport const Button = () => null',
      );
      expect([...result.names].sort()).toEqual(["Button", "registry"]);
      expect(result.exhaustive).toBe(true);
    });

    test("`as const` at end of line followed by a semicolon-less export resolves correctly", () => {
      const result = names(
        'export const theme = { bg: "#000" } as const\nexport const Button = () => null',
      );
      expect([...result.names].sort()).toEqual(["Button", "theme"]);
      expect(result.exhaustive).toBe(true);
    });
  });

  // The task brief's own instruction: invent at least ten shapes nobody has tested yet, aimed at
  // `isStatementPosition` and the `<` rule, and confirm the invariant holds for each. All twelve
  // below were run against the implementation before being pinned here — see the round-4 fix
  // report for the full write-up, including the one (the last two cases) that found a genuine
  // third gap and was fixed rather than merely reported.
  describe("adversarial pass beyond the brief's matrix (fix round 4)", () => {
    test("a semicolon immediately followed by another export on the same line", () => {
      const result = names("export const a = 1;export const b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a semicolon-terminated declarator followed by an unexported function declaration", () => {
      const result = names("export const a = 1; export function b() {}");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("an object literal's own internal commas do not leak into the declarator list", () => {
      const result = names("export const a = { x: 1, y: 2 }, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.names.has("x")).toBe(false);
      expect(result.names.has("y")).toBe(false);
      expect(result.exhaustive).toBe(true);
    });

    test("an array literal's own internal commas do not leak into the declarator list", () => {
      const result = names("export const a = [1, 2, 3], b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a genuine less-than comparison fails open but keeps the name read so far", () => {
      const result = names("export const a = 1 < 2, b = 3");
      expect(result.names.has("a")).toBe(true);
      expect(result.exhaustive).toBe(false);
    });

    test("a bare `>` with no matching `<` is ordinary content, not a boundary", () => {
      const result = names("export const a = b > 1 ? 2 : 3, c = 4");
      expect([...result.names].sort()).toEqual(["a", "c"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a `<`/`>` comparison wrapped in real parentheses is swallowed whole", () => {
      const result = names("export const a = (x > 1 ? 2 : 3), b = 4");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a leading comma on the next line still continues the same declarator list", () => {
      const result = names("export const a = 1\n, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("`async` used as a plain value, not a function modifier, is read through safely", () => {
      const result = names("export const a = async, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a `.type` access right after an already-swallowed object literal is still read through", () => {
      const result = names("export const a = { type: 1 }.type, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("an unrelated, unexported declaration between two exports corrupts neither", () => {
      const result = names("export const a = function () {}\nconst helper = 1\nexport const b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    // A genuine THIRD gap found by this pass, distinct from Critical A/B, and fixed rather than
    // merely reported: `type`/`async`/… are legal TypeScript identifiers (`export const type = 1`
    // is valid), but `Tok.value` is only populated for literal/Identifier-kind tokens (see
    // `./scanner.ts`'s `Tok`), so this scan can prove such a name exists yet cannot read it. Every
    // prior round's code (and the original brief's own algorithm) silently `continue`d past the
    // FIRST declarator's name check without ever touching `exhaustive` — a real Critical-B-shaped
    // hole: a component literally named `type` would be invisible while `exhaustive` stayed
    // `true`. Fixed in this round by failing open there instead (see `scanNamedExports`'s
    // `first?.kind !== SK.Identifier` branch).
    test("a declarator literally named a contextual keyword fails open instead of vanishing silently", () => {
      const result = names("export const type = 1, b = 2");
      expect(result.exhaustive).toBe(false);
    });

    test("a LATER declarator named a contextual keyword still keeps the names read so far", () => {
      const result = names("export const a = 1, type = 2");
      expect(result.names.has("a")).toBe(true);
      expect(result.exhaustive).toBe(false);
    });
  });
});

// Fix round 5 (task review Critical finding): round 4's `<` rule set `exhaustive: false` for the
// WHOLE FILE the instant any `<` was seen — sound in isolation (a `<`/`>` pair genuinely cannot
// be balanced by counting, since `a < b, c > d` is a valid comparison), but its blast radius was
// wrong. A design-system component module is a `.tsx` file whose dominant idiom is an arrow
// function returning JSX (`export const Button = () => <box .../>`), and JSX markup tokenizes as
// a bare `LessThanToken` plus ordinary tokens — there is no distinct JSX token kind at the
// scanner level (confirmed by tokenizing `<box id="b" />` directly: it lexes as
// `LessThanToken, Identifier, Identifier, EqualsToken, StringLiteral, GreaterThanToken`, no
// different in kind from `Map<string, T>`'s). So round 4 reported `exhaustive: false` for
// essentially every real component module, silencing `DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING` on
// exactly the files it exists to police — a check that is present, tested, green, and inert on
// real input.
//
// The fix (`scanPastAngleBracket`) narrows the blast radius from "the whole file" to "only when a
// name could actually have been missed": scan ahead from the `<` to the current statement's own
// boundary, and only fail open if a depth-0 comma — the one thing a `<` could have hidden a
// declarator separator behind — turned up before it. See `scanPastAngleBracket`'s doc comment.
describe("scanNamedExports — a `<` costs only what it must (fix round 5)", () => {
  describe("JSX component modules stay exhaustive", () => {
    test("a single arrow component", () => {
      const result = names('export const Button = () => <box id="b" />', "jsx");
      expect(result.names.has("Button")).toBe(true);
      expect(result.exhaustive).toBe(true);
    });

    test("two arrow components in one file", () => {
      const result = names(
        'export const Button = () => <box id="b" />\nexport const Panel = () => <box id="p" />',
        "jsx",
      );
      expect([...result.names].sort()).toEqual(["Button", "Panel"]);
      expect(result.exhaustive).toBe(true);
    });

    test("nested JSX children", () => {
      const result = names('export const Button = () => <box id="b"><text>hi</text></box>', "jsx");
      expect(result.names.has("Button")).toBe(true);
      expect(result.exhaustive).toBe(true);
    });

    test("JSX attribute expressions ({1}, {2}) do not trip the rule", () => {
      const result = names("export const Button = () => <box a={1} b={2} />", "jsx");
      expect(result.names.has("Button")).toBe(true);
      expect(result.exhaustive).toBe(true);
    });

    test("JSX with a .map callback containing a comma (the comma sits inside real parens)", () => {
      const result = names("export const Button = () => <box>{xs.map((i, k) => i)}</box>", "jsx");
      expect(result.names.has("Button")).toBe(true);
      expect(result.exhaustive).toBe(true);
    });

    // Deliberately still `exhaustive: false`: a real generic-argument comma (`new Map<string,
    // T>()`) sits alongside the JSX component in the SAME file, so the whole file fails open —
    // this is Critical A's fix still doing its job, not a regression of this round's fix.
    test("a JSX component alongside a new Map<string, T>() export is deliberately still exhaustive: false", () => {
      const result = names(
        'export const Button = () => <box id="b" />\nexport const registry = new Map<string, number>()',
        "jsx",
      );
      expect([...result.names].sort()).toEqual(["Button", "registry"]);
      expect(result.exhaustive).toBe(false);
    });
  });

  describe("Critical A shapes stay exhaustive: false (regression guard)", () => {
    test.each([
      "export const registry = new Map<string, ComponentSpec>();",
      "export const cache: Record<string, Comp> = {}",
      "export const p: Promise<Result<A, B>> = q",
      "export const v = pick<A, B>(x), w = 2",
      "export const a = x as Map<Foo, Bar>, b = 2",
      "export const f = <T, U>(a: T, b: U) => a",
    ])("%s still reports exhaustive: false", (source) => {
      expect(names(source).exhaustive).toBe(false);
    });
  });

  describe("adversarial pass on the new `<` handling (fix round 5)", () => {
    test("JSX generics <Foo<T> /> do not invent a phantom name and stay exhaustive", () => {
      const result = names("export const Foo = () => <Foo<T> />", "jsx");
      expect(result.names.has("Foo")).toBe(true);
      expect(result.names.has("T")).toBe(false);
      expect(result.exhaustive).toBe(true);
    });

    test("a comparison chain (1 < 2 < 3) with a real trailing comma fails open", () => {
      const result = names("export const a = 1 < 2 < 3, b = 4");
      expect(result.names.has("a")).toBe(true);
      expect(result.exhaustive).toBe(false);
    });

    test("a `<` inside a template interpolation never reaches the `<` rule at all", () => {
      const result = names("export const a = `${x < 1}`, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a `<` inside a skipped function body never reaches the `<` rule at all", () => {
      const result = names("export const a = function () { return x < 1 }, b = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });

    test("a `<` in a MIDDLE declarator with a real comma after it fails open but keeps prior names", () => {
      const result = names("export const a = 1, b = x < 1, c = 2");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.names.has("c")).toBe(false);
      expect(result.exhaustive).toBe(false);
    });

    test("a `<` in the LAST declarator, with nothing after it, stays exhaustive", () => {
      const result = names("export const a = 1, b = x < 1");
      expect([...result.names].sort()).toEqual(["a", "b"]);
      expect(result.exhaustive).toBe(true);
    });
  });
});

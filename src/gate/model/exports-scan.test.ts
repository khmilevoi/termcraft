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
// See the doc comments on `scanNamedExports` and `NamedExportScanV1.exhaustive` for the full
// rationale, and `skipInitializerKeyword` for the skip itself.
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

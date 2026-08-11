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

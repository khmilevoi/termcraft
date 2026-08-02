import { describe, expect, test } from "bun:test";

import type { SourceStreamTruncatedError } from "./lexer";
import { checkPageContract } from "./page-contract";

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

const good = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

describe("checkPageContract (runtime-api §4)", () => {
  test("a well-formed page passes and yields the parsed meta", () => {
    const result = scanned(checkPageContract(good));
    expect(result.errors).toEqual([]);
    expect(result.meta).toEqual({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
    });
  });

  test("meta bound to something other than a definePage call is NON_STATIC_META", () => {
    const src = `const raw = { kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" }\nexport const meta = raw\nexport default reatomComponent(() => null)\n`;
    expect(scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_STATIC_META")).toBe(
      true,
    );
  });

  test("a spread inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ...base, kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_STATIC_META")).toBe(
      true,
    );
  });

  test("a computed key inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ["kitApiVersion"]: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_STATIC_META")).toBe(
      true,
    );
  });

  test("a variable reference as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: VERSION, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_STATIC_META")).toBe(
      true,
    );
  });

  test("a call as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: makeTitle(), minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_STATIC_META")).toBe(
      true,
    );
  });

  test("a missing required field is MISSING_META_FIELD", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const codes = scanned(checkPageContract(src)).errors.map((e) => e.code);
    expect(codes).toContain("MISSING_META_FIELD");
  });

  test("an unsupported kitApiVersion is UNSUPPORTED_KIT_API", () => {
    const src = `export const meta = definePage({ kitApiVersion: 99, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src)).errors.some((e) => e.code === "UNSUPPORTED_KIT_API"),
    ).toBe(true);
  });

  test("no default export is MISSING_DEFAULT_EXPORT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\n`;
    expect(
      scanned(checkPageContract(src)).errors.some((e) => e.code === "MISSING_DEFAULT_EXPORT"),
    ).toBe(true);
  });

  test("a default export that is not a reatomComponent is NON_REATOM_DEFAULT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default function Page() { return null }\n`;
    expect(
      scanned(checkPageContract(src)).errors.some((e) => e.code === "NON_REATOM_DEFAULT"),
    ).toBe(true);
  });
});

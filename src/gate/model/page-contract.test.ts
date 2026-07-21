import { describe, expect, test } from "bun:test";

import { checkPageContract } from "./page-contract";

const good = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)
`;

describe("checkPageContract (runtime-api §4)", () => {
  test("a well-formed page passes and yields the parsed meta", () => {
    const result = checkPageContract(good);
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
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_STATIC_META")).toBe(true);
  });

  test("a spread inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ...base, kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_STATIC_META")).toBe(true);
  });

  test("a computed key inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ["kitApiVersion"]: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_STATIC_META")).toBe(true);
  });

  test("a variable reference as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: VERSION, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_STATIC_META")).toBe(true);
  });

  test("a call as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: makeTitle(), minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_STATIC_META")).toBe(true);
  });

  test("a missing required field is MISSING_META_FIELD", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const codes = checkPageContract(src).errors.map((e) => e.code);
    expect(codes).toContain("MISSING_META_FIELD");
  });

  test("an unsupported kitApiVersion is UNSUPPORTED_KIT_API", () => {
    const src = `export const meta = definePage({ kitApiVersion: 99, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "UNSUPPORTED_KIT_API")).toBe(true);
  });

  test("no default export is MISSING_DEFAULT_EXPORT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "MISSING_DEFAULT_EXPORT")).toBe(
      true,
    );
  });

  test("a default export that is not a reatomComponent is NON_REATOM_DEFAULT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default function Page() { return null }\n`;
    expect(checkPageContract(src).errors.some((e) => e.code === "NON_REATOM_DEFAULT")).toBe(true);
  });
});

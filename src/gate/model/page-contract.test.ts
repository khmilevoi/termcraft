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
    const result = scanned(checkPageContract(good, "jsx"));
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
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_STATIC_META"),
    ).toBe(true);
  });

  test("a spread inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ...base, kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_STATIC_META"),
    ).toBe(true);
  });

  test("a computed key inside the meta object is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ ["kitApiVersion"]: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_STATIC_META"),
    ).toBe(true);
  });

  test("a variable reference as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: VERSION, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_STATIC_META"),
    ).toBe(true);
  });

  test("a call as a field value is NON_STATIC_META", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: makeTitle(), minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_STATIC_META"),
    ).toBe(true);
  });

  test("a missing required field is MISSING_META_FIELD", () => {
    // `theme` is OPTIONAL (design-systems §4.6, task 2) so this omits `title` instead — one of
    // the three fields that still remain required.
    const src = `export const meta = definePage({ kitApiVersion: 1, minSize: { w: 80, h: 24 } })\nexport default reatomComponent(() => null)\n`;
    const codes = scanned(checkPageContract(src, "jsx")).errors.map((e) => e.code);
    expect(codes).toContain("MISSING_META_FIELD");
  });

  test("an unsupported kitApiVersion is UNSUPPORTED_KIT_API", () => {
    const src = `export const meta = definePage({ kitApiVersion: 99, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default reatomComponent(() => null)\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "UNSUPPORTED_KIT_API"),
    ).toBe(true);
  });

  test("no default export is MISSING_DEFAULT_EXPORT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some(
        (e) => e.code === "MISSING_DEFAULT_EXPORT",
      ),
    ).toBe(true);
  });

  test("a default export that is not a reatomComponent is NON_REATOM_DEFAULT", () => {
    const src = `export const meta = definePage({ kitApiVersion: 1, title: "x", minSize: { w: 80, h: 24 }, theme: "dark-default" })\nexport default function Page() { return null }\n`;
    expect(
      scanned(checkPageContract(src, "jsx")).errors.some((e) => e.code === "NON_REATOM_DEFAULT"),
    ).toBe(true);
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

describe("checkPageContract — a stream that does not cover the source is an ERROR, never a meta-less result", () => {
  test("lets the unreadable-source throw PASS rather than returning a contract verdict", () => {
    // An unread stream also has no `meta` in it, so swallowing reports "this page declares no
    // meta" — a false diagnosis that sends the agent to fix a contract that is probably fine,
    // while whatever the file actually hides goes unchecked.
    expect(() => checkPageContract(UNREADABLE, "jsx")).toThrow();
  });

  test("…and an ordinary source still gets a real verdict, so this is not a blanket refusal", () => {
    const result = scanned(checkPageContract(COVERED, "jsx"));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.meta).toBeNull();
  });
});

describe("meta.theme is optional (design-systems §4.6)", () => {
  const page = (
    metaBody: string,
  ) => `import { definePage, reatomComponent } from "@termcraft/runtime"
export const meta = definePage({ ${metaBody} })
export default reatomComponent(function Page() { return null })
`;

  test("a page omitting `theme` passes the contract, with meta.theme undefined", () => {
    const result = checkPageContract(
      page(`kitApiVersion: 1, title: "T", minSize: { w: 80, h: 24 }`),
      "jsx",
    );
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    expect(result.errors).toEqual([]);
    expect(result.meta).not.toBeNull();
    expect(result.meta?.theme).toBeUndefined();
  });

  test("a page declaring `theme` still carries it verbatim", () => {
    const result = checkPageContract(
      page(`kitApiVersion: 1, title: "T", minSize: { w: 80, h: 24 }, theme: "midnight"`),
      "jsx",
    );
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    expect(result.errors).toEqual([]);
    expect(result.meta?.theme).toBe("midnight");
  });

  test("a PRESENT but non-string `theme` is still MISSING_META_FIELD", () => {
    // Optional means "may be absent", never "may be anything". A numeric theme is a page that
    // meant to pin a theme and got it wrong; reporting nothing would hide that.
    const result = checkPageContract(
      page(`kitApiVersion: 1, title: "T", minSize: { w: 80, h: 24 }, theme: 7`),
      "jsx",
    );
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    expect(result.errors.map((e) => e.code)).toContain("MISSING_META_FIELD");
    expect(result.meta).toBeNull();
  });

  test("the other three fields stay required", () => {
    const result = checkPageContract(page(`title: "T", minSize: { w: 80, h: 24 }`), "jsx");
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    expect(result.errors.map((e) => e.code)).toContain("MISSING_META_FIELD");
  });
});

import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import {
  lintDeterminism,
  lintDroppedIds,
  lintUnlistedNavigation,
  lintUnpointedElements,
} from "./lints";

describe("lintDeterminism (§6.3 non-fatal determinism warnings)", () => {
  test("a deterministic page produces no warnings", () => {
    expect(lintDeterminism(`const rows = [1, 2, 3].map((n) => n * 2)\n`)).toEqual([]);
  });

  test("setTimeout / setInterval each warn as an unguarded timer", () => {
    const w = lintDeterminism(`setTimeout(() => {}, 10)\nsetInterval(() => {}, 10)\n`);
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("Math.random warns as unguarded randomness", () => {
    const w = lintDeterminism(`const r = Math.random()\n`);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unguarded-randomness");
  });

  test("Date.now / performance.now warn as unguarded timers", () => {
    const w = lintDeterminism(`const a = Date.now()\nconst b = performance.now()\n`);
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("a property access unrelated to time/randomness does not warn", () => {
    expect(
      lintDeterminism(`const x = obj.now\nconst y = Math.max(1, 2)\nconst z = user.random\n`),
    ).toEqual([]);
  });

  test("warnings carry a source position", () => {
    const w = lintDeterminism(`\nconst r = Math.random()\n`);
    expect(w[0]?.line).toBe(2);
  });
});

describe("lintDroppedIds (§6.3 dropped-id warning)", () => {
  test("absent referencedIds skips the lint entirely (gate stays runnable standalone)", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(lintDroppedIds(src)).toEqual([]);
  });

  test("a referenced id still present in the candidate produces no warning", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(lintDroppedIds(src, ["p", "t"])).toEqual([]);
  });

  test("a referenced id absent from the candidate's ids warns dropped-id", () => {
    const src = `export default reatomComponent(() => <Panel id="p">hi</Panel>)\n`;
    const w = lintDroppedIds(src, ["p", "cpu-gauge"]);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("dropped-id");
    expect(w[0]?.message).toContain("cpu-gauge");
  });

  test("every dropped id is reported, not just the first", () => {
    const w = lintDroppedIds(`export default reatomComponent(() => <Panel id="p" />)\n`, [
      "a",
      "b",
    ]);
    expect(w).toHaveLength(2);
  });

  test('an id bound via object-property form (`id: "x"`) also counts as present', () => {
    const src = `const props = { id: "cpu-gauge" }\n`;
    expect(lintDroppedIds(src, ["cpu-gauge"])).toEqual([]);
  });

  test("a `data-id` prop is NOT mistaken for a declared `id` (Minor 4)", () => {
    // Before the fix, `extractDeclaredIds` matched the bare token text "id" —
    // the second half of the hyphenated `data-id` — and silently counted
    // "cpu" as if the candidate had declared `id="cpu"`.
    const w = lintDroppedIds(`export default () => <box data-id="cpu">x</box>\n`, ["cpu"]);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("dropped-id");
    expect(w[0]?.message).toContain("cpu");
  });
});

describe("lintUnpointedElements (§6.3 unpointed-element warning)", () => {
  test("kit components (capitalized tag) with ids produce no warning", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(lintUnpointedElements(src)).toEqual([]);
  });

  test("a raw low-level element (lowercase tag) without an id warns", () => {
    const w = lintUnpointedElements(`export default () => <box>raw</box>\n`);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unpointed-element");
  });

  test("a raw element WITH an id does not warn", () => {
    expect(lintUnpointedElements(`export default () => <box id="raw-1">raw</box>\n`)).toEqual([]);
  });

  test("a self-closing raw element without an id warns", () => {
    const w = lintUnpointedElements(`export default () => <box />\n`);
    expect(w).toHaveLength(1);
  });

  test("every unpointed raw element is reported, not just the first", () => {
    const w = lintUnpointedElements(`export default () => <box><text>hi</text></box>\n`);
    expect(w).toHaveLength(2);
  });

  test("kit components are exempt even without an id (enforced elsewhere)", () => {
    expect(lintUnpointedElements(`export default () => <Panel><Text>hi</Text></Panel>\n`)).toEqual(
      [],
    );
  });

  test("a raw element nested inside a pointed kit component still warns", () => {
    const w = lintUnpointedElements(`export default () => <Panel id="p"><box>raw</box></Panel>\n`);
    expect(w).toHaveLength(1);
  });

  test("a brace expression inside a tag (e.g. a ternary using `>`) does not confuse the tag scan", () => {
    const w = lintUnpointedElements(
      `export default () => <box id="b" color={x > y ? "a" : "b"} />\n`,
    );
    expect(w).toEqual([]);
  });

  test("a Fragment shorthand does not itself warn", () => {
    expect(lintUnpointedElements(`export default () => <><Text id="t">hi</Text></>\n`)).toEqual([]);
  });

  test("a `<` used as a plain comparison operator (`a < b`) does not warn (Important 1)", () => {
    expect(lintUnpointedElements(`const z = a < b\n`)).toEqual([]);
  });

  test("a `<` comparison against a member access (`rows.length < max`) does not warn (Important 1)", () => {
    expect(lintUnpointedElements(`const overflow = rows.length < max\n`)).toEqual([]);
  });

  test("a `<` inside a for-loop condition (`i < len`) does not warn (Important 1)", () => {
    expect(lintUnpointedElements(`for (let i = 0; i < len; i += 1) {}\n`)).toEqual([]);
  });

  test("a generic type argument on a call (`useRef<lowerType>(null)`) does not warn (Important 1)", () => {
    expect(lintUnpointedElements(`const ref = useRef<lowerType>(null)\n`)).toEqual([]);
  });

  test("a hyphenated prop (`data-id`) is NOT mistaken for the `id` prop — the element still warns (Also fix)", () => {
    const w = lintUnpointedElements(`export default () => <box data-id="x">raw</box>\n`);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unpointed-element");
  });

  test("a hyphenated prop (`aria-id`) is NOT mistaken for the `id` prop — the element still warns (Also fix)", () => {
    const w = lintUnpointedElements(`export default () => <box aria-id="x">raw</box>\n`);
    expect(w).toHaveLength(1);
  });

  test("a genuinely hyphenated tag name is still scanned correctly (no false negative from the merge fix)", () => {
    expect(
      lintUnpointedElements(`export default () => <my-widget id="w">raw</my-widget>\n`),
    ).toEqual([]);
  });

  describe("Minor 3 (fix pass 2) — residual gaps, pinned as current behavior, not fixed here", () => {
    test("KNOWN GAP: two bare assignments sandwiched between two comparisons still misreads a bogus <b>", () => {
      // Contrived: needs two comparisons and two `const`/`let`-free, paren/comma
      // /semicolon-free assignments in between. `scanOpenTag` reads "b" as a tag
      // name, "foo"/"bar"/"c" as its props, and the second comparison's `>` as
      // the tag's own terminator.
      const w = lintUnpointedElements(`a < b\nfoo = "x"\nbar = c > d\n`);
      expect(w).toHaveLength(1);
      expect(w[0]?.message).toContain("<b>");
    });

    test('KNOWN GAP: a text child starting with "(" is silenced by the generic-call guard (`<box>(hi)</box>`)', () => {
      // The "closing `>` immediately followed by `(`" guard exists to reject
      // `Identifier<Type>(...)` generic calls; it cannot tell that shape apart
      // from a real, unpointed element whose text child happens to start with
      // a parenthesis, so this one produces no warning at all.
      expect(lintUnpointedElements(`export default () => <box>(hi)</box>\n`)).toEqual([]);
    });
  });
});

describe("lintUnlistedNavigation (§6.3 unlisted-navigation warning)", () => {
  const DASH = "dash" as PageSlug;
  const SETTINGS = "settings" as PageSlug;

  test("absent listedSlugs skips the lint entirely (gate stays runnable standalone)", () => {
    expect(lintUnlistedNavigation(`usePages().goTo("nowhere")\n`)).toEqual([]);
  });

  test("navigation to a listed slug produces no warning", () => {
    const w = lintUnlistedNavigation(`usePages().goTo("settings")\n`, [DASH, SETTINGS]);
    expect(w).toEqual([]);
  });

  test("navigation to a slug absent from the list warns unlisted-navigation", () => {
    const w = lintUnlistedNavigation(`usePages().goTo("missing")\n`, [DASH]);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unlisted-navigation");
    expect(w[0]?.message).toContain("missing");
  });

  test("every unlisted navigation call is reported, not just the first", () => {
    const w = lintUnlistedNavigation(`usePages().goTo("a")\nusePages().goTo("b")\n`, [DASH]);
    expect(w).toHaveLength(2);
  });

  test("a .goTo call not chained off usePages() is not mistaken for navigation", () => {
    expect(lintUnlistedNavigation(`foo.goTo("missing")\n`, [DASH])).toEqual([]);
  });
});

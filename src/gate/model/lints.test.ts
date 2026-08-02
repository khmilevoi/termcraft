import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import type { SourceStreamTruncatedError } from "./lexer";
import {
  lintDeterminism,
  lintDroppedIds,
  lintSilencingAny,
  lintUnlistedNavigation,
  lintUnpointedElements,
} from "./lints";

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

/**
 * THE TURN THIS LINT COMES FROM (2026-07-27). The gate rejected a candidate with two
 * `TS7006 Parameter 'ctx' implicitly has an 'any' type` errors — the only signal that the
 * page was calling a Reatom API this runtime does not have. The agent's next attempt
 * annotated both parameters `ctx: any`, which silenced the compiler exactly as asked, passed
 * the gate, committed, and threw `TypeError: ctx.spy is not a function` on the first render.
 * `any` written to make a type error go away is the failure mode; the lint says so out loud
 * on the attempt that introduces it, while the agent can still act on it.
 */
describe("lintSilencingAny (an `any` written to make a type error go away)", () => {
  test("a page with no `any` produces no warnings", () => {
    expect(scanned(lintSilencingAny(`const n: number = 1\nconst s = String(n)\n`))).toEqual([]);
  });

  test("an annotated parameter warns", () => {
    const w = scanned(
      lintSilencingAny(`const setPalette = action((ctx: any, id: string) => {})\n`),
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("silencing-any");
    expect(w[0]?.line).toBe(1);
  });

  test("an `as any` assertion warns", () => {
    const w = scanned(lintSilencingAny(`const page = mod.default as any\n`));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("silencing-any");
  });

  test("an object property or member named `any` is not an annotation and does not warn", () => {
    expect(scanned(lintSilencingAny(`const o = { any: 1 }\nconst v = o.any\n`))).toEqual([]);
  });

  test("the word `any` inside a string or an identifier does not warn", () => {
    expect(scanned(lintSilencingAny(`const label = "any color"\nconst anything = 2\n`))).toEqual(
      [],
    );
  });

  test("every occurrence is reported, each at its own position", () => {
    const w = scanned(lintSilencingAny(`function f(a: any) {}\n\nfunction g(b: any) {}\n`));
    expect(w).toHaveLength(2);
    expect(w[0]?.line).toBe(1);
    expect(w[1]?.line).toBe(3);
  });
});

describe("lintDeterminism (§6.3 non-fatal determinism warnings)", () => {
  test("a deterministic page produces no warnings", () => {
    expect(scanned(lintDeterminism(`const rows = [1, 2, 3].map((n) => n * 2)\n`))).toEqual([]);
  });

  test("setTimeout / setInterval each warn as an unguarded timer", () => {
    const w = scanned(lintDeterminism(`setTimeout(() => {}, 10)\nsetInterval(() => {}, 10)\n`));
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("Math.random warns as unguarded randomness", () => {
    const w = scanned(lintDeterminism(`const r = Math.random()\n`));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unguarded-randomness");
  });

  test("Date.now / performance.now warn as unguarded timers", () => {
    const w = scanned(lintDeterminism(`const a = Date.now()\nconst b = performance.now()\n`));
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "unguarded-timer")).toBe(true);
  });

  test("a property access unrelated to time/randomness does not warn", () => {
    expect(
      scanned(
        lintDeterminism(`const x = obj.now\nconst y = Math.max(1, 2)\nconst z = user.random\n`),
      ),
    ).toEqual([]);
  });

  test("warnings carry a source position", () => {
    const w = scanned(lintDeterminism(`\nconst r = Math.random()\n`));
    expect(w[0]?.line).toBe(2);
  });
});

describe("lintDroppedIds (§6.3 dropped-id warning)", () => {
  test("absent referencedIds skips the lint entirely (gate stays runnable standalone)", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(scanned(lintDroppedIds(src))).toEqual([]);
  });

  test("a referenced id still present in the candidate produces no warning", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(scanned(lintDroppedIds(src, ["p", "t"]))).toEqual([]);
  });

  test("a referenced id absent from the candidate's ids warns dropped-id", () => {
    const src = `export default reatomComponent(() => <Panel id="p">hi</Panel>)\n`;
    const w = scanned(lintDroppedIds(src, ["p", "cpu-gauge"]));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("dropped-id");
    expect(w[0]?.message).toContain("cpu-gauge");
  });

  test("every dropped id is reported, not just the first", () => {
    const w = scanned(
      lintDroppedIds(`export default reatomComponent(() => <Panel id="p" />)\n`, ["a", "b"]),
    );
    expect(w).toHaveLength(2);
  });

  test('an id bound via object-property form (`id: "x"`) also counts as present', () => {
    const src = `const props = { id: "cpu-gauge" }\n`;
    expect(scanned(lintDroppedIds(src, ["cpu-gauge"]))).toEqual([]);
  });

  test("a `data-id` prop is NOT mistaken for a declared `id` (Minor 4)", () => {
    // Before the fix, `extractDeclaredIds` matched the bare token text "id" —
    // the second half of the hyphenated `data-id` — and silently counted
    // "cpu" as if the candidate had declared `id="cpu"`.
    const w = scanned(lintDroppedIds(`export default () => <box data-id="cpu">x</box>\n`, ["cpu"]));
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

  test('a namespaced attribute whose NAMESPACE segment is `id` (`id:foo="x"`) is NOT mistaken for a bare `id` — the element still warns', () => {
    const w = lintUnpointedElements(`export default () => <box id:foo="x">raw</box>\n`);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unpointed-element");
  });

  test("a genuinely hyphenated tag name is still scanned correctly (no false negative from the merge fix)", () => {
    expect(
      lintUnpointedElements(`export default () => <my-widget id="w">raw</my-widget>\n`),
    ).toEqual([]);
  });

  describe("Important 2 (fix pass 4) — everyday JSX forms no longer lose the element", () => {
    test("a raw element carrying only a spread attribute still warns (it declares no `id`)", () => {
      const w = lintUnpointedElements(`export default () => <box {...rest}>raw</box>\n`);
      expect(w).toHaveLength(1);
      expect(w[0]?.kind).toBe("unpointed-element");
    });

    test("a raw element whose attribute value is a template literal still warns", () => {
      const w = lintUnpointedElements("export default () => <box label={`R${n}`}>raw</box>\n");
      expect(w).toHaveLength(1);
    });

    test("a member-expression tag is a component reference — exempt, like any capitalized tag", () => {
      expect(lintUnpointedElements(`export default () => <Kit.Text>hi</Kit.Text>\n`)).toEqual([]);
    });
  });

  describe("Finding 5 (fix pass 5) — a dotted tag name is a component reference regardless of case", () => {
    test("an all-lowercase dotted tag (`<kit.box>`) is exempt, like any dotted tag", () => {
      expect(lintUnpointedElements(`export default () => <kit.box>raw</kit.box>\n`)).toEqual([]);
    });
  });

  describe("Also fix (fix pass 5) — a duplicated `scanJsx` element is not warned twice", () => {
    test("a nested element read once by a doomed attribute-list attempt and once by the retry produces one warning, not two", () => {
      const w = lintUnpointedElements(`export default () => <box a={<text>hi</text>} 1>x</box>\n`);
      expect(w).toHaveLength(1);
      expect(w[0]?.kind).toBe("unpointed-element");
    });
  });

  describe("Minor 3 (fix pass 2) residual gaps — closed by the fix-pass-3 real JSX reader", () => {
    test("two bare assignments sandwiched between two comparisons no longer misread a bogus <b> (fix-pass-3)", () => {
      // Contrived: needs two comparisons and two `const`/`let`-free, paren/comma
      // /semicolon-free assignments in between. The old `scanOpenTag` heuristic
      // read "b" as a tag name, "foo"/"bar"/"c" as its props, and the second
      // comparison's `>` as the tag's own terminator. `scanJsx` never attempts
      // `<b` at all: the identifier `a` right before it already ends a primary
      // expression (`endsExpression` in `./jsx`), so there is nothing here to
      // misread as an unpointed element.
      expect(lintUnpointedElements(`a < b\nfoo = "x"\nbar = c > d\n`)).toEqual([]);
    });

    test('a text child starting with "(" now correctly warns (`<box>(hi)</box>`) (fix-pass-3)', () => {
      // The old heuristic's "closing `>` immediately followed by `(`" guard
      // (needed to reject `Identifier<Type>(...)` generic calls) could not
      // tell that shape apart from a real, unpointed element whose text child
      // happens to start with a parenthesis, so it silenced this case
      // entirely. `scanJsx`'s children reader has no such guard to confuse —
      // `(` inside JSX children is just ordinary text — so this is now
      // correctly recognized as a real, unpointed element.
      const w = lintUnpointedElements(`export default () => <box>(hi)</box>\n`);
      expect(w).toHaveLength(1);
      expect(w[0]?.kind).toBe("unpointed-element");
    });
  });
});

describe("lintUnlistedNavigation (§6.3 unlisted-navigation warning)", () => {
  const DASH = "dash" as PageSlug;
  const SETTINGS = "settings" as PageSlug;

  test("absent listedSlugs skips the lint entirely (gate stays runnable standalone)", () => {
    expect(scanned(lintUnlistedNavigation(`usePages().goTo("nowhere")\n`))).toEqual([]);
  });

  test("navigation to a listed slug produces no warning", () => {
    const w = scanned(lintUnlistedNavigation(`usePages().goTo("settings")\n`, [DASH, SETTINGS]));
    expect(w).toEqual([]);
  });

  test("navigation to a slug absent from the list warns unlisted-navigation", () => {
    const w = scanned(lintUnlistedNavigation(`usePages().goTo("missing")\n`, [DASH]));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unlisted-navigation");
    expect(w[0]?.message).toContain("missing");
  });

  test("every unlisted navigation call is reported, not just the first", () => {
    const w = scanned(
      lintUnlistedNavigation(`usePages().goTo("a")\nusePages().goTo("b")\n`, [DASH]),
    );
    expect(w).toHaveLength(2);
  });

  test("a .goTo call not chained off usePages() is not mistaken for navigation", () => {
    expect(scanned(lintUnlistedNavigation(`foo.goTo("missing")\n`, [DASH]))).toEqual([]);
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
 * THE FIXTURE IS ONE BUN ACCEPTS AND EXECUTES: JSX attribute strings do not process `\` escapes
 * and code-mode strings do, so `a="x\"` ends the attribute for the runtime while the code lexer
 * reads on through `>hi</Text>` and past it.
 */
const TRUNCATING = `export const G = () => <Text a="x\\">hi</Text>\nimport fs from "node:fs"\n`;
const COVERED = `export const G = () => <Text a="x">hi</Text>\nimport fs from "node:fs"\n`;

describe("the token-based lints — a stream that does not cover the source is an ERROR, never zero warnings", () => {
  test("lintDeterminism returns the truncation rather than []", () => {
    expect(lintDeterminism(TRUNCATING)).toBeInstanceOf(Error);
  });

  test("lintSilencingAny returns the truncation rather than []", () => {
    expect(lintSilencingAny(TRUNCATING)).toBeInstanceOf(Error);
  });

  test("lintDroppedIds returns the truncation rather than []", () => {
    expect(lintDroppedIds(TRUNCATING, ["a"])).toBeInstanceOf(Error);
  });

  test("lintUnlistedNavigation returns the truncation rather than []", () => {
    expect(lintUnlistedNavigation(TRUNCATING, ["home" as PageSlug])).toBeInstanceOf(Error);
  });

  test("…and every one of them still runs on the covered sibling — not a blanket refusal", () => {
    expect(scanned(lintDeterminism(COVERED))).toEqual([]);
    expect(scanned(lintSilencingAny(COVERED))).toEqual([]);
    expect(scanned(lintDroppedIds(COVERED, []))).toEqual([]);
    expect(scanned(lintUnlistedNavigation(COVERED, []))).toEqual([]);
  });
});

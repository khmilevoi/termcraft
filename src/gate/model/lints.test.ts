import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import type { GateWarning } from "../types";
import type { SourceStreamTruncatedError } from "./lexer";
import {
  lintDeterminism,
  lintDroppedIds,
  lintModuleScopeTokens,
  lintSilencingAny,
  lintTokenNameColors,
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
    expect(scanned(lintSilencingAny(`const n: number = 1\nconst s = String(n)\n`, "jsx"))).toEqual(
      [],
    );
  });

  test("an annotated parameter warns", () => {
    const w = scanned(
      lintSilencingAny(`const setPalette = action((ctx: any, id: string) => {})\n`, "jsx"),
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("silencing-any");
    expect(w[0]?.line).toBe(1);
  });

  test("an `as any` assertion warns", () => {
    const w = scanned(lintSilencingAny(`const page = mod.default as any\n`, "jsx"));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("silencing-any");
  });

  test("an object property or member named `any` is not an annotation and does not warn", () => {
    expect(scanned(lintSilencingAny(`const o = { any: 1 }\nconst v = o.any\n`, "jsx"))).toEqual([]);
  });

  test("the word `any` inside a string or an identifier does not warn", () => {
    expect(
      scanned(lintSilencingAny(`const label = "any color"\nconst anything = 2\n`, "jsx")),
    ).toEqual([]);
  });

  test("every occurrence is reported, each at its own position", () => {
    const w = scanned(lintSilencingAny(`function f(a: any) {}\n\nfunction g(b: any) {}\n`, "jsx"));
    expect(w).toHaveLength(2);
    expect(w[0]?.line).toBe(1);
    expect(w[1]?.line).toBe(3);
  });
});

describe("lintDeterminism (§6.3 non-fatal determinism warnings — renamed 2026-08-09)", () => {
  test("a deterministic page produces no warnings", () => {
    expect(scanned(lintDeterminism(`const rows = [1, 2, 3].map((n) => n * 2)\n`, "jsx"))).toEqual(
      [],
    );
  });

  test("setTimeout / setInterval each warn as nondeterministic-time", () => {
    const w = scanned(
      lintDeterminism(`setTimeout(() => {}, 10)\nsetInterval(() => {}, 10)\n`, "jsx"),
    );
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "nondeterministic-time")).toBe(true);
  });

  test("Math.random warns as nondeterministic-randomness", () => {
    const w = scanned(lintDeterminism(`const r = Math.random()\n`, "jsx"));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("nondeterministic-randomness");
  });

  test("Date.now / performance.now warn as nondeterministic-time", () => {
    const w = scanned(
      lintDeterminism(`const a = Date.now()\nconst b = performance.now()\n`, "jsx"),
    );
    expect(w).toHaveLength(2);
    expect(w.every((x) => x.kind === "nondeterministic-time")).toBe(true);
  });

  test("a property access unrelated to time/randomness does not warn", () => {
    expect(
      scanned(
        lintDeterminism(
          `const x = obj.now\nconst y = Math.max(1, 2)\nconst z = user.random\n`,
          "jsx",
        ),
      ),
    ).toEqual([]);
  });

  test("warnings carry a source position", () => {
    const w = scanned(lintDeterminism(`\nconst r = Math.random()\n`, "jsx"));
    expect(w[0]?.line).toBe(2);
  });

  /**
   * THE FULL VOCABULARY (task-4, design-agent-feedback-loop repair). `new Date()` used to be
   * the one wall-clock read this lint missed — an accident of token shape (`Date.now()` is
   * identifier+dot+member, `new Date()` is `new`+identifier+`(`+`)`) rather than a judgement —
   * and the measured run's agent noticed the asymmetry and explicitly declined to exploit it.
   * `new Date(2026, 0, 1)` is deliberately absent from this list: see the dedicated seeded-
   * constructor tests below for why it is a NEGATIVE case, not a positive one.
   */
  test.each([
    ["Date.now()", "nondeterministic-time"],
    ["performance.now()", "nondeterministic-time"],
    ["new Date()", "nondeterministic-time"],
    ["setTimeout(f, 0)", "nondeterministic-time"],
    ["setInterval(f, 0)", "nondeterministic-time"],
    ["setImmediate(f)", "nondeterministic-time"],
    ["requestAnimationFrame(f)", "nondeterministic-time"],
    ["Math.random()", "nondeterministic-randomness"],
  ] as const)("%s is flagged as %s", (src, kind) => {
    const out = lintDeterminism(`const x = ${src};`, "no-jsx");
    expect(out).not.toBeInstanceOf(Error);
    expect((out as GateWarning[]).map((w) => w.kind)).toContain(kind);
  });

  test.each([
    "const d = { Date: 1 }.Date;",
    "const o = { now: 1 }; o.now;",
    "class Date2 {}; new Date2();",
    "const random = 4; random;",
    "obj.Math.random;", // a MEMBER named Math, not the global
  ] as const)("%s is not flagged", (src) => {
    expect(lintDeterminism(src, "no-jsx")).toEqual([]);
  });

  /**
   * THE SEEDED-CONSTRUCTOR EXEMPTION (spike 13, load-bearing: three real dependents in
   * `examples/clock`'s `calendar.tsx`). A `new Date(...)` call WITH explicit arguments reads
   * no wall clock — it is the only wall-clock-free way to build a `Date` — so flagging it
   * would teach an agent to avoid dates altogether rather than to avoid the clock. Only the
   * four-token, argument-less shape (`new` `Date` `(` `)`) is flagged.
   */
  test("new Date(2026, 0, 1) is a seeded constructor and is NOT flagged", () => {
    const out = scanned(lintDeterminism("const x = new Date(2026, 0, 1);", "no-jsx"));
    expect(out).toEqual([]);
  });

  test("new Date(ms) — a single-argument seeded constructor — is NOT flagged either", () => {
    const out = scanned(lintDeterminism("const x = new Date(1234567890);", "no-jsx"));
    expect(out).toEqual([]);
  });

  test("new Date() is counted once, never double-counted as a bare `Date` identifier reference", () => {
    const out = scanned(lintDeterminism("const x = new Date();", "no-jsx"));
    expect(out).toHaveLength(1);
  });

  /**
   * NO KIND NAME PROMISES A GUARD (rename, 2026-08-09). This lint is a token scan with no
   * scope analysis, so it can never observe whether an `isExport()` wrapper encloses a call —
   * the old `unguarded-*` names promised exactly that, and a measured retry added such a
   * guard, reported "fixed", and the warnings never cleared because the scanner cannot see
   * guards at all.
   */
  test("no kind name promises a guard", () => {
    const out = scanned(lintDeterminism("Date.now(); Math.random();", "no-jsx"));
    for (const w of out) {
      expect(w.kind).not.toContain("unguarded");
      expect(w.message).not.toContain("guard");
    }
  });

  test("each message says what to do instead", () => {
    const out = scanned(lintDeterminism("Date.now();", "no-jsx"));
    expect(out[0]?.message).toContain("atom");
  });
});

describe("lintDroppedIds (§6.3 dropped-id warning)", () => {
  test("absent referencedIds skips the lint entirely (gate stays runnable standalone)", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(scanned(lintDroppedIds(src, "jsx"))).toEqual([]);
  });

  test("a referenced id still present in the candidate produces no warning", () => {
    const src = `export default reatomComponent(() => <Panel id="p"><Text id="t">hi</Text></Panel>)\n`;
    expect(scanned(lintDroppedIds(src, "jsx", ["p", "t"]))).toEqual([]);
  });

  test("a referenced id absent from the candidate's ids warns dropped-id", () => {
    const src = `export default reatomComponent(() => <Panel id="p">hi</Panel>)\n`;
    const w = scanned(lintDroppedIds(src, "jsx", ["p", "cpu-gauge"]));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("dropped-id");
    expect(w[0]?.message).toContain("cpu-gauge");
  });

  test("every dropped id is reported, not just the first", () => {
    const w = scanned(
      lintDroppedIds(`export default reatomComponent(() => <Panel id="p" />)\n`, "jsx", ["a", "b"]),
    );
    expect(w).toHaveLength(2);
  });

  test('an id bound via object-property form (`id: "x"`) also counts as present', () => {
    const src = `const props = { id: "cpu-gauge" }\n`;
    expect(scanned(lintDroppedIds(src, "jsx", ["cpu-gauge"]))).toEqual([]);
  });

  test("a `data-id` prop is NOT mistaken for a declared `id` (Minor 4)", () => {
    // Before the fix, `extractDeclaredIds` matched the bare token text "id" —
    // the second half of the hyphenated `data-id` — and silently counted
    // "cpu" as if the candidate had declared `id="cpu"`.
    const w = scanned(
      lintDroppedIds(`export default () => <box data-id="cpu">x</box>\n`, "jsx", ["cpu"]),
    );
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
    expect(scanned(lintUnlistedNavigation(`usePages().goTo("nowhere")\n`, "jsx"))).toEqual([]);
  });

  test("navigation to a listed slug produces no warning", () => {
    const w = scanned(
      lintUnlistedNavigation(`usePages().goTo("settings")\n`, "jsx", [DASH, SETTINGS]),
    );
    expect(w).toEqual([]);
  });

  test("navigation to a slug absent from the list warns unlisted-navigation", () => {
    const w = scanned(lintUnlistedNavigation(`usePages().goTo("missing")\n`, "jsx", [DASH]));
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("unlisted-navigation");
    expect(w[0]?.message).toContain("missing");
  });

  test("every unlisted navigation call is reported, not just the first", () => {
    const w = scanned(
      lintUnlistedNavigation(`usePages().goTo("a")\nusePages().goTo("b")\n`, "jsx", [DASH]),
    );
    expect(w).toHaveLength(2);
  });

  test("a .goTo call not chained off usePages() is not mistaken for navigation", () => {
    expect(scanned(lintUnlistedNavigation(`foo.goTo("missing")\n`, "jsx", [DASH]))).toEqual([]);
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

describe("the token-based lints — a stream that does not cover the source is an ERROR, never zero warnings", () => {
  test("lintDeterminism lets the throw PASS rather than returning []", () => {
    expect(() => lintDeterminism(UNREADABLE, "jsx")).toThrow();
  });

  test("lintSilencingAny lets the throw PASS rather than returning []", () => {
    expect(() => lintSilencingAny(UNREADABLE, "jsx")).toThrow();
  });

  test("lintDroppedIds lets the throw PASS rather than returning []", () => {
    expect(() => lintDroppedIds(UNREADABLE, "jsx", ["a"])).toThrow();
  });

  test("lintUnlistedNavigation lets the throw PASS rather than returning []", () => {
    expect(() => lintUnlistedNavigation(UNREADABLE, "jsx", ["home" as PageSlug])).toThrow();
  });

  test("lintModuleScopeTokens lets the throw PASS rather than returning []", () => {
    expect(() => lintModuleScopeTokens(UNREADABLE, "jsx")).toThrow();
  });

  test("lintTokenNameColors lets the throw PASS rather than returning []", () => {
    expect(() => lintTokenNameColors(UNREADABLE, "jsx")).toThrow();
  });

  test("…and every one of them still runs on an ordinary source — not a blanket refusal", () => {
    expect(scanned(lintDeterminism(COVERED, "jsx"))).toEqual([]);
    expect(scanned(lintSilencingAny(COVERED, "jsx"))).toEqual([]);
    expect(scanned(lintDroppedIds(COVERED, "jsx", []))).toEqual([]);
    expect(scanned(lintUnlistedNavigation(COVERED, "jsx", []))).toEqual([]);
    expect(scanned(lintModuleScopeTokens(COVERED, "jsx"))).toEqual([]);
    expect(scanned(lintTokenNameColors(COVERED, "jsx"))).toEqual([]);
  });
});

describe("lintModuleScopeTokens (design-systems §4.5, §7)", () => {
  const kinds = (source: string) => {
    // NOTE: the brief's own snippet used "tsx", which is not a valid `SourceSyntax` —
    // `lexer.ts` declares `SourceSyntax = "jsx" | "no-jsx"`. Corrected to "jsx" here.
    const result = lintModuleScopeTokens(source, "jsx");
    if (result instanceof Error) throw result;
    return result.map((w) => w.kind);
  };

  test("a call at module scope warns", () => {
    expect(kinds(`import { useTokens } from "../system/tokens"\nconst t = useTokens()\n`)).toEqual([
      "module-scope-tokens",
    ]);
  });

  test("the warning names the fix, not just the fault", () => {
    const result = lintModuleScopeTokens(`const t = useTokens()\n`, "jsx");
    if (result instanceof Error) throw result;
    expect(result[0]?.message).toContain("inside the component");
    expect(result[0]?.line).toBe(1);
  });

  test("a call inside a component body is clean", () => {
    expect(
      kinds(
        `export default reatomComponent(function Page() {\n  const t = useTokens()\n  return null\n})\n`,
      ),
    ).toEqual([]);
  });

  test("the §4.3 scaffold stays clean — a regression pin, not a guard pin", () => {
    // NOT actually exercising the `=>` guard (review finding 3): the scaffold's `useTokens` is a
    // declaration binding (`useTokens = …`, followed by `=` not `(`) and the call inside it is a
    // DIFFERENT identifier (`useRuntimeTokens`), so the shape check alone already rejects both —
    // this passes with or without the `=>` guard. Kept anyway as a regression pin: if a future
    // change to the shape check ever made it match `useTokens = (...)`-style bindings, this would
    // catch it turning the tool's own generated file non-clean.
    expect(
      kinds(
        `import { useTokens as useRuntimeTokens, type Color } from "@termcraft/runtime"\n` +
          `import ds from "./design-system.json"\n\n` +
          `export type Tokens = { [K in keyof (typeof ds)["themes"]["dark-default"]["tokens"]]: Color }\n` +
          `export const useTokens = () => useRuntimeTokens<Tokens>()\n`,
      ),
    ).toEqual([]);
  });

  test("an arrow with a BRACE body is clean too — the call is inside the brace", () => {
    expect(kinds(`const read = () => {\n  const t = useTokens()\n  return t\n}\n`)).toEqual([]);
  });

  test("a second module-scope call after a braced function still warns", () => {
    // The `=>` latch must reset at a statement boundary, or one arrow anywhere would disable the
    // lint for the rest of the file. This source has no braces and no semicolons — the boundary
    // between the two statements is drawn only by automatic semicolon insertion, which the token
    // stream carries no token for, so the latch must reset on the second line's `const` keyword.
    expect(kinds(`const read = () => useTokens()\nconst t = useTokens()\n`)).toEqual([
      "module-scope-tokens",
    ]);
  });

  test("an IMPORT of the name is not a call", () => {
    expect(kinds(`import { useTokens } from "../system/tokens"\n`)).toEqual([]);
  });

  test("a call WITH arguments is not this lint's business", () => {
    expect(kinds(`const t = useTokens(1)\n`)).toEqual([]);
  });

  test("a member access is not the runtime hook", () => {
    expect(kinds(`const t = kit.useTokens()\n`)).toEqual([]);
  });

  describe("a lazy arrow helper reading useTokens() more than once is clean (review finding 1)", () => {
    // A reset on the CALL closing (an earlier draft of this lint) made every one of these warn on
    // their second read — still inside the same un-braced arrow expression, still a legitimate
    // deferred read, and an over-report D10 forbids. The fix resets the latch on a statement-start
    // keyword token instead, which cannot appear mid-expression.
    test("two reads combined by an operator", () => {
      expect(kinds(`const f = () => useTokens() + useTokens()\n`)).toEqual([]);
    });

    test("two reads inside an array literal", () => {
      expect(kinds(`const pair = () => [useTokens().fg, useTokens().bg]\n`)).toEqual([]);
    });

    test("two reads joined by nullish coalescing, after export/const before the arrow", () => {
      expect(kinds(`export const c = () => useTokens().bg ?? useTokens().fg\n`)).toEqual([]);
    });

    test("two reads on either side of a conditional expression", () => {
      expect(kinds(`const g = () => (cond ? useTokens() : useTokens())\n`)).toEqual([]);
    });
  });
});

describe("lintTokenNameColors (design-systems §4.5, §7, §9)", () => {
  const only = (source: string) => {
    // NOTE: the brief's own snippet used "tsx", which is not a valid `SourceSyntax` —
    // `lexer.ts` declares `SourceSyntax = "jsx" | "no-jsx"`. Corrected to "jsx" here, same as
    // `lintModuleScopeTokens`'s test block above.
    const result = lintTokenNameColors(source, "jsx");
    if (result instanceof Error) throw result;
    return result;
  };

  test("carries the EXACT rewrite, not a bare complaint", () => {
    const [warning] = only(`<Text id="t" color="foregroundMuted">hi</Text>`);
    expect(warning?.kind).toBe("token-name-as-color");
    expect(warning?.message).toContain('color="foregroundMuted"');
    expect(warning?.message).toContain("color={t.foregroundMuted}");
    expect(warning?.message).toContain("const t = useTokens()");
  });

  test("fires on every Color-typed prop the catalog declares", () => {
    // `color`, `background`, `borderColor`, `titleColor` are the four in `src/runtime/ui/*.tsx`
    // today; the `*Color` suffix rule is what makes the wrapper plans (P5-P9) need no edit here.
    expect(
      only(`<Panel id="p" borderColor="accent" titleColor="accentHi" background="surface" />`)
        .length,
    ).toBe(3);
  });

  test("a real hex is clean", () => {
    expect(only(`<Text id="t" color="#e6a23c">hi</Text>`)).toEqual([]);
  });

  test("an expression binding is clean — that is the shape this lint is teaching", () => {
    expect(only(`<Text id="t" color={t.accent}>hi</Text>`)).toEqual([]);
  });

  test("a non-colour prop with a string value is clean", () => {
    expect(only(`<Text id="title" title="accent">hi</Text>`)).toEqual([]);
  });

  test("a hyphenated attribute whose tail is `color` is NOT a colour prop", () => {
    // The lexer hands `data`, `-`, `color` back as three tokens; a bare tail match would read
    // `data-color` as `color`.
    expect(only(`<box data-color="accent" id="b">x</box>`)).toEqual([]);
  });

  test("the warning carries a position", () => {
    const [warning] = only(`<Text\n  id="t"\n  color="accent"\n/>`);
    expect(warning?.line).toBe(3);
  });
});

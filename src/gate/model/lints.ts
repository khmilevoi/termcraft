import type { PageSlug } from "entities/page";

import type { GateWarning } from "../types";
import { SK, lineColOf, tokenize } from "./lexer";
import type { Tok } from "./lexer";

/** Global identifiers whose call breaks the deterministic render (§6.3 warning lints). */
const TIMER_IDENTIFIERS = new Set<string>([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "requestAnimationFrame",
]);
/** `X.now()` time sources that are non-deterministic across a smoke/export render. */
const NOW_OBJECTS = new Set<string>(["Date", "performance"]);

/**
 * The token-scannable determinism warning lints (master §6.3). A page rendered for
 * smoke/export at logical `t = 0` must not depend on wall-clock time or randomness;
 * these produce NON-FATAL warnings (the gate reminds, not rejects). A raw
 * `setTimeout`/`setInterval`, a `Date.now()`/`performance.now()`, or a `Math.random()`
 * each surfaces one warning at its source position. (`dropped-id`,
 * `unpointed-element`, and `unlisted-navigation` are below.)
 */
export function lintDeterminism(source: string): GateWarning[] {
  const toks = tokenize(source);
  const warnings: GateWarning[] = [];
  const at = (pos: number) => lineColOf(source, pos);

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind !== SK.Identifier) continue;

    if (TIMER_IDENTIFIERS.has(t.value)) {
      warnings.push({
        kind: "unguarded-timer",
        message: `\`${t.value}\` is non-deterministic — a smoke/export render is sealed at t=0`,
        ...at(t.pos),
      });
      continue;
    }
    // `Math.random` and `Date.now`/`performance.now` — an identifier + `.` + member.
    if (toks[i + 1]?.kind === SK.DotToken && toks[i + 2]?.kind === SK.Identifier) {
      const member = toks[i + 2]!.value;
      if (t.value === "Math" && member === "random") {
        warnings.push({
          kind: "unguarded-randomness",
          message: "`Math.random()` is non-deterministic — seed or precompute for a stable render",
          ...at(t.pos),
        });
      } else if (NOW_OBJECTS.has(t.value) && member === "now") {
        warnings.push({
          kind: "unguarded-timer",
          message: `\`${t.value}.now()\` reads wall-clock time — non-deterministic in a sealed render`,
          ...at(t.pos),
        });
      }
    }
  }

  return warnings;
}

/** One scanned JSX opening tag: its full (possibly hyphenated) name and whether it carries an `id` prop. */
interface OpenTagScan {
  readonly tagName: string;
  readonly hasId: boolean;
}

/**
 * Read a (possibly hyphenated) name starting at `start`: `id`, but also
 * `data-id`, `aria-label`, `my-widget`, etc. — the lexer sees each hyphen as
 * its own `MinusToken`, so a tag/prop name spanning one is only complete once
 * the merge stops (§6.3 Also-fix: this is what keeps `data-id`/`aria-id` from
 * being counted as the `id` prop below — the merged name is compared for
 * equality as a whole, never a single identifier segment in isolation).
 * Returns `null` when `start` isn't an Identifier at all. `next` is the token
 * index right after the merged name.
 */
function readHyphenatedName(
  toks: readonly Tok[],
  start: number,
): { readonly name: string; readonly next: number } | null {
  const first = toks[start];
  if (first === undefined || first.kind !== SK.Identifier) return null;
  let name = first.value;
  let j = start + 1;
  while (toks[j]?.kind === SK.MinusToken && toks[j + 1]?.kind === SK.Identifier) {
    name += `-${toks[j + 1]!.value}`;
    j += 2;
  }
  return { name, next: j };
}

/**
 * Scan one JSX opening tag starting at its `<` token (`start`): the (possibly
 * hyphenated) tag name, then its prop list up to the tag's own closing `>`/`/>` —
 * tracking brace depth so an expression-container prop value (e.g.
 * `color={x > y ? "a" : "b"}`) never terminates the scan early on the `>` inside
 * it. Returns `null` when `start` is not a real element's opening tag:
 *
 * - a closing `</...>` or a bare `<>` Fragment start, neither of which names
 *   an element (`first` isn't an Identifier);
 * - the tag name doesn't sit directly against `<` — no line break between them
 *   (Important 1) — so a `<` used as a relational operator with its right-hand
 *   operand pushed to a later line is never mistaken for a tag start;
 * - the walk hits a token that can never appear at depth 0 inside a JSX
 *   attribute list — `;`, a depth-0 `)`/`,`, another `<`, any keyword, a bare
 *   number, … (Important 1) — before it ever finds a closing `>`. The lexer is
 *   `LanguageVariant.Standard` (`lexer.ts`), so `<` is indistinguishable from
 *   `LessThanToken`-the-operator; without this abort the walk would happily
 *   cross statement/expression boundaries (`a < b`, `i < len` in a `for`
 *   condition) hunting for *some* later `>`, however unrelated;
 * - the walk runs off the end of the token stream without ever finding a
 *   closing `>` at all (Important 1) — the exact shape `a < b` and
 *   `rows.length < max` leave behind: a tag name with nothing after it that
 *   could possibly close a tag;
 * - the found closing `>` is immediately followed by a call's `(` (Important
 *   1) — `Identifier<Type>(...)` (a generic type-argument list, e.g.
 *   `useRef<T>()`) is lexically identical to a childless open tag up to this
 *   point, and the one shape a *real* element's `>` is never followed by is a
 *   call paren (you cannot invoke a rendered element), so that shape is
 *   rejected here instead of trying to tell "generic call" from "JSX" earlier.
 *
 * A generic type-argument list with no following call (`Array<Foo>`) is not
 * separately special-cased: an uppercase argument is already exempt as a Kit
 * component by `lintUnpointedElements`, and a lowercase one violates
 * TypeScript's near-universal PascalCase type-naming convention — an
 * accepted, narrow residual gap (see the Important-1 route note in the fix
 * report) rather than one worth an extra guard.
 */
function scanOpenTag(toks: readonly Tok[], start: number, source: string): OpenTagScan | null {
  const first = toks[start + 1];
  if (first === undefined || first.kind !== SK.Identifier) return null;

  const openTok = toks[start]!;
  if (source.slice(openTok.pos + 1, first.pos).includes("\n")) return null;

  const tagRead = readHyphenatedName(toks, start + 1)!;
  const tagName = tagRead.name;

  let hasId = false;
  let depth = 0;
  let foundTerminator = false;
  let j = tagRead.next;
  for (; j < toks.length; j += 1) {
    const t = toks[j]!;
    if (t.kind === SK.OpenBraceToken) {
      depth += 1;
      continue;
    }
    if (t.kind === SK.CloseBraceToken) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (t.kind === SK.GreaterThanToken) {
      foundTerminator = true;
      break;
    }
    if (t.kind === SK.SlashToken) continue; // the self-closing `/>` marker
    if (t.kind === SK.EqualsToken || t.kind === SK.StringLiteral) continue;
    if (t.kind === SK.Identifier) {
      const prop = readHyphenatedName(toks, j)!;
      if (prop.name === "id") hasId = true;
      j = prop.next - 1; // the loop's own `j += 1` lands exactly on `prop.next`
      continue;
    }
    // Impossible inside a JSX attribute list at depth 0 — this `<` was never
    // a real tag start. See the exit-condition list in the doc comment above.
    return null;
  }
  if (!foundTerminator) return null;
  if (toks[j + 1]?.kind === SK.OpenParenToken) return null; // `Identifier<Type>(...)` generic call

  return { tagName, hasId };
}

/**
 * The `unpointed-element` warning (§6.3 step 3; §5.2's escape hatch: "the Gate
 * reminds, not rejects"). A JSX tag's capitalization is the load-bearing signal:
 * a capitalized tag is a component reference, and because the import allowlist
 * (§3.1) permits only `@termcraft/runtime`, every such component is a Kit
 * component whose id the page contract and the smoke render's duplicate check
 * already enforce (§5.2) — exempt here. A lowercase tag is a low-level/raw
 * OpenTUI primitive (the runtime's escape hatch, e.g. `<box>`/`<text>`); one with
 * no `id` prop warns, because the designer is expected to be able to point at it.
 */
export function lintUnpointedElements(source: string): GateWarning[] {
  const toks = tokenize(source);
  const warnings: GateWarning[] = [];
  const at = (pos: number) => lineColOf(source, pos);

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind !== SK.LessThanToken) continue;
    const scan = scanOpenTag(toks, i, source);
    if (scan === null || scan.hasId) continue;
    const firstChar = scan.tagName[0]!;
    if (firstChar < "a" || firstChar > "z") continue; // capitalized — a Kit component, exempt
    warnings.push({
      kind: "unpointed-element",
      message: `<${scan.tagName}> is a raw element with no \`id\` — pointing (selection/pins) needs one`,
      ...at(t.pos),
    });
  }

  return warnings;
}

/**
 * The set of ids the candidate declares anywhere in its source: a string literal
 * bound to an `id` attribute (`id="p"`, the JSX form) or an `id` property
 * (`id: "p"`, the object-literal form). Used by `lintDroppedIds` (below), which
 * needs the literal id VALUES to match against `referencedIds` — unlike
 * `unpointed-element`'s `scanOpenTag`, which only needs to know a tag carries
 * *some* `id` prop, literal or not.
 *
 * Deliberately literal-only (§6.3 Also-fix): `<box id={rowId}>` does not add
 * anything here, because `rowId` isn't a `StringLiteral`. That means a
 * list-rendered page whose row ids come from a variable/expression looks, to
 * this function, like it declares no ids at all — every id referenced by
 * selection/pins on such a page will warn `dropped-id` on every candidate,
 * looking like a permanent regression rather than a one-off. This is the
 * conventions warning taken literally, not a bug: §6.3 step 3 asks for
 * "stable ids across iterations", and a dynamically-bound id is exactly the
 * shape that convention is warning against — the lint has no way to know a
 * `rowId` expression still evaluates to the same referenced id turn over
 * turn, so it treats it as dropped rather than silently trusting it.
 */
function extractDeclaredIds(toks: readonly Tok[]): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind !== SK.Identifier || t.value !== "id") continue;
    const sep = toks[i + 1];
    const value = toks[i + 2];
    if (sep === undefined || value === undefined) continue;
    if (
      (sep.kind === SK.EqualsToken || sep.kind === SK.ColonToken) &&
      value.kind === SK.StringLiteral
    ) {
      ids.add(value.value);
    }
  }
  return ids;
}

/**
 * The `dropped-id` warning (§6.3 step 3): "dropped ids that selection or open pins
 * currently reference." The kernel's turn driver supplies the referenced ids from
 * outside the gate — the caller's selection/pin state, not the prior source — so
 * this lint needs no history of its own. Absent `referencedIds` skips the lint
 * entirely (the gate stays runnable standalone). One warning per referenced id
 * that the candidate no longer declares.
 */
export function lintDroppedIds(source: string, referencedIds?: readonly string[]): GateWarning[] {
  if (referencedIds === undefined) return [];

  const toks = tokenize(source);
  const declaredIds = extractDeclaredIds(toks);
  const warnings: GateWarning[] = [];

  for (const id of referencedIds) {
    if (declaredIds.has(id)) continue;
    warnings.push({
      kind: "dropped-id",
      message: `id "${id}" is referenced by selection or an open pin but is no longer present in this candidate`,
    });
  }

  return warnings;
}

/**
 * The `unlisted-navigation` warning (§6.3 step 3): "navigation to unlisted
 * pages." Targets the runtime navigation capability's specced call form
 * (design §5.5: `usePages().goTo("settings")`; runtime-api §6 names
 * "navigation" as the capability family — not yet implemented, WP-8) — a direct
 * `usePages()` call chained straight into `.goTo("<slug>")`. `listedSlugs` is
 * the staged manifest slice's page list (`checkManifestSlice`); absent, this
 * lint skips entirely (the gate stays runnable standalone). One warning per
 * navigation call whose literal target isn't in the list.
 */
export function lintUnlistedNavigation(
  source: string,
  listedSlugs?: readonly PageSlug[],
): GateWarning[] {
  if (listedSlugs === undefined) return [];

  const listed = new Set<string>(listedSlugs);
  const toks = tokenize(source);
  const warnings: GateWarning[] = [];
  const at = (pos: number) => lineColOf(source, pos);

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind !== SK.Identifier || t.value !== "usePages") continue;
    const goTo = toks[i + 4];
    const target = toks[i + 6];
    if (
      toks[i + 1]?.kind !== SK.OpenParenToken ||
      toks[i + 2]?.kind !== SK.CloseParenToken ||
      toks[i + 3]?.kind !== SK.DotToken ||
      goTo === undefined ||
      goTo.kind !== SK.Identifier ||
      goTo.value !== "goTo" ||
      toks[i + 5]?.kind !== SK.OpenParenToken ||
      target === undefined ||
      target.kind !== SK.StringLiteral
    )
      continue;
    if (listed.has(target.value)) continue;
    warnings.push({
      kind: "unlisted-navigation",
      message: `usePages().goTo("${target.value}") targets a page not listed in pages.json`,
      ...at(t.pos),
    });
  }

  return warnings;
}

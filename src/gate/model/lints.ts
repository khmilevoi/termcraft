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
 * Scan one JSX opening tag starting at its `<` token (`start`): the (possibly
 * hyphenated) tag name, then its prop list up to the tag's own closing `>` —
 * tracking brace depth so an expression-container prop value (e.g.
 * `color={x > y ? "a" : "b"}`) never terminates the scan early on the `>` inside
 * it. Returns `null` when `start` is not an element's opening tag: a closing
 * `</...>` or a bare `<>` Fragment start, neither of which names an element.
 */
function scanOpenTag(toks: readonly Tok[], start: number): OpenTagScan | null {
  const first = toks[start + 1];
  if (first === undefined || first.kind !== SK.Identifier) return null;

  let tagName = first.value;
  let j = start + 2;
  while (toks[j]?.kind === SK.MinusToken && toks[j + 1]?.kind === SK.Identifier) {
    tagName += `-${toks[j + 1]!.value}`;
    j += 2;
  }

  let hasId = false;
  let depth = 0;
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
    if (t.kind === SK.GreaterThanToken) break;
    if (t.kind === SK.Identifier && t.value === "id") hasId = true;
  }

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
    const scan = scanOpenTag(toks, i);
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

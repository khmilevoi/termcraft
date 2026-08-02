import type { PageSlug } from "entities/page";

import type { GateWarning } from "../types";
import { readHyphenatedName, scanJsx } from "./jsx";
import { SK, lineColOf, tokenize } from "./lexer";
import type { SourceStreamTruncatedError, SourceSyntax, Tok } from "./lexer";

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
export function lintDeterminism(
  source: string,
  syntax: SourceSyntax,
): SourceStreamTruncatedError | GateWarning[] {
  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;
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

/**
 * The `silencing-any` warning (defect fix, 2026-07-27). Non-fatal, in the same voice as the
 * determinism lints above: the gate reminds, it does not reject.
 *
 * Written because `any` is the one escape hatch that converts a caught error into an
 * uncaught one. A live turn was told `TS7006 Parameter 'ctx' implicitly has an 'any' type`
 * — the compiler's report that the page was calling an API this runtime does not have — and
 * "fixed" it by writing `ctx: any`. The type error went away, the gate passed, the page
 * committed, and it threw `TypeError: ctx.spy is not a function` on the first render.
 *
 * Deliberately narrowed to `: any` and `as any`, the two shapes that suppress a diagnostic.
 * TypeScript's scanner emits `AnyKeyword` for the bare word wherever it appears — including
 * a property named `any` (`{ any: 1 }`, `o.any`) that the PARSER, not the scanner, resolves
 * as an identifier — so matching the keyword alone would warn on code that has no annotation
 * in it at all. Checking the preceding token is what keeps this precise.
 */
export function lintSilencingAny(
  source: string,
  syntax: SourceSyntax,
): SourceStreamTruncatedError | GateWarning[] {
  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;
  const warnings: GateWarning[] = [];

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind !== SK.AnyKeyword) continue;
    const prev = toks[i - 1];
    if (prev === undefined) continue;
    if (prev.kind !== SK.ColonToken && prev.kind !== SK.AsKeyword) continue;
    warnings.push({
      kind: "silencing-any",
      message:
        "`any` here suppresses a type error instead of fixing it — if a parameter's type is not " +
        "obvious, the call shape is wrong; see REATOM.md",
      ...lineColOf(source, t.pos),
    });
  }

  return warnings;
}

/**
 * The `unpointed-element` warning (§6.3 step 3; §5.2's escape hatch: "the Gate
 * reminds, not rejects"). A JSX tag's capitalization is the load-bearing signal:
 * a capitalized tag is a component reference, and because the import allowlist
 * (§3.1) permits only `@termcraft/runtime`, every such component is a Kit
 * component whose id the page contract and the smoke render's duplicate check
 * already enforce (§5.2) — exempt here. A DOTTED tag (`<Kit.Text>`, or an
 * all-lowercase `<kit.box>`) is exempt the same way, regardless of its first
 * segment's case: a member-expression tag name is always a reference to some
 * imported value, never a raw JSX intrinsic, so there is no first character
 * left to judge. A lowercase, non-dotted tag is a low-level/raw OpenTUI
 * primitive (the runtime's escape hatch, e.g. `<box>`/`<text>`); one with no
 * `id` prop warns, because the designer is expected to be able to point at it.
 *
 * Built on `scanJsx` (`./jsx`, WP-6a fix-pass-3) — the same real-scanner JSX
 * reader `import-scan.ts`'s dynamic-code check uses — rather than an earlier
 * walk over a plain code-token array, which this replaces outright: `scanJsx`
 * requires a genuine matching close tag (or a real `/>`) before it will
 * report an element at all, which incidentally closes both of that earlier
 * walk's residual gaps (WP-6a fix-pass-2, Minor 3) rather than needing a
 * second heuristic layer to chase them —
 *
 * - `a < b\nfoo = "x"\nbar = c > d`: `scanJsx` never even attempts `<b`, since
 *   the identifier `a` right before it already ends an expression
 *   (`endsExpression` in `./jsx`) — no bogus `<b>` warning.
 * - `<box>(hi)</box>`: a text child starting with `(` is read as ordinary JSX
 *   text (`scanJsxToken` doesn't lex `(` specially), so this now correctly
 *   warns as a real, unpointed element instead of being silently dropped.
 */
export function lintUnpointedElements(source: string): GateWarning[] {
  const { elements } = scanJsx(source);
  const at = (pos: number) => lineColOf(source, pos);

  const warnings: GateWarning[] = [];
  for (const el of elements) {
    if (el.hasId || el.tagName === "") continue;
    if (el.tagName.includes(".")) continue; // dotted — a component reference, exempt regardless of case
    const firstChar = el.tagName[0]!;
    if (firstChar < "a" || firstChar > "z") continue; // capitalized — a Kit component, exempt
    warnings.push({
      kind: "unpointed-element",
      message: `<${el.tagName}> is a raw element with no \`id\` — pointing (selection/pins) needs one`,
      ...at(el.pos),
    });
  }

  return warnings;
}

/**
 * The set of ids the candidate declares anywhere in its source: a string literal
 * bound to an `id` attribute (`id="p"`, the JSX form) or an `id` property
 * (`id: "p"`, the object-literal form). Used by `lintDroppedIds` (below), which
 * needs the literal id VALUES to match against `referencedIds` — unlike
 * `unpointed-element` above, which only needs to know a tag carries *some* `id`
 * prop, literal or not (`scanJsx`'s `hasId`).
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
 *
 * Merges hyphenated names with `readHyphenatedName` (`./jsx`), the CODE-token
 * counterpart of the `scanJsxIdentifier()` merge the real JSX reader uses:
 * without it, a bare `Identifier` check for the token text `"id"` matches the
 * second half of `data-id="cpu"` too, since the lexer
 * hands back `data`, `-`, `id` as three separate tokens — that made
 * `lintDroppedIds('<box data-id="cpu">x</box>', ["cpu"])` report no warning
 * at all, silently treating a `data-id` as if it declared `id="cpu"`.
 */
function extractDeclaredIds(toks: readonly Tok[]): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < toks.length; i += 1) {
    if (toks[i]!.kind !== SK.Identifier) continue;
    const nameRead = readHyphenatedName(toks, i)!; // kind already checked Identifier, never null
    if (nameRead.name === "id") {
      const sep = toks[nameRead.next];
      const value = toks[nameRead.next + 1];
      if (
        sep !== undefined &&
        value !== undefined &&
        (sep.kind === SK.EqualsToken || sep.kind === SK.ColonToken) &&
        value.kind === SK.StringLiteral
      ) {
        ids.add(value.value);
      }
    }
    i = nameRead.next - 1; // the loop's own `i += 1` lands exactly on `nameRead.next`
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
export function lintDroppedIds(
  source: string,
  syntax: SourceSyntax,
  referencedIds?: readonly string[],
): SourceStreamTruncatedError | GateWarning[] {
  if (referencedIds === undefined) return [];

  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;
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
  syntax: SourceSyntax,
  listedSlugs?: readonly PageSlug[],
): SourceStreamTruncatedError | GateWarning[] {
  if (listedSlugs === undefined) return [];

  const listed = new Set<string>(listedSlugs);
  const toks = tokenize(source, syntax);
  if (toks instanceof Error) return toks;
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

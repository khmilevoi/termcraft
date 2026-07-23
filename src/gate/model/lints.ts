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
 * each surfaces one warning at its source position. (`unpointed-element` needs a
 * JSX open-tag scan and `unlisted-navigation` needs the manifest's listed slugs —
 * both still deferred to their stages. `dropped-id` is below: it only needs the
 * caller-supplied `referencedIds`, not the whole prior source.)
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

/**
 * The set of ids the candidate declares anywhere in its source: a string literal
 * bound to an `id` attribute (`id="p"`, the JSX form) or an `id` property
 * (`id: "p"`, the object-literal form). Shared by `lintDroppedIds` (below) and
 * `unpointed-element`'s open-tag scan.
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

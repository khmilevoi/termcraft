import type { GateWarning } from "../types"
import { lineColOf, SK, tokenize } from "./lexer"

/** Global identifiers whose call breaks the deterministic render (§6.3 warning lints). */
const TIMER_IDENTIFIERS = new Set<string>(["setTimeout", "setInterval", "setImmediate", "requestAnimationFrame"])
/** `X.now()` time sources that are non-deterministic across a smoke/export render. */
const NOW_OBJECTS = new Set<string>(["Date", "performance"])

/**
 * The token-scannable determinism warning lints (master §6.3). A page rendered for
 * smoke/export at logical `t = 0` must not depend on wall-clock time or randomness;
 * these produce NON-FATAL warnings (the gate reminds, not rejects). A raw
 * `setTimeout`/`setInterval`, a `Date.now()`/`performance.now()`, or a `Math.random()`
 * each surfaces one warning at its source position. (The `unpointed-element`,
 * `dropped-id`, and `unlisted-navigation` lints need a JSX-aware AST, the prior
 * iteration's ids, and the manifest respectively — deferred to their stages.)
 */
export function lintDeterminism(source: string): GateWarning[] {
  const toks = tokenize(source)
  const warnings: GateWarning[] = []
  const at = (pos: number) => lineColOf(source, pos)

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!
    if (t.kind !== SK.Identifier) continue

    if (TIMER_IDENTIFIERS.has(t.value)) {
      warnings.push({ kind: "unguarded-timer", message: `\`${t.value}\` is non-deterministic — a smoke/export render is sealed at t=0`, ...at(t.pos) })
      continue
    }
    // `Math.random` and `Date.now`/`performance.now` — an identifier + `.` + member.
    if (toks[i + 1]?.kind === SK.DotToken && toks[i + 2]?.kind === SK.Identifier) {
      const member = toks[i + 2]!.value
      if (t.value === "Math" && member === "random") {
        warnings.push({ kind: "unguarded-randomness", message: "`Math.random()` is non-deterministic — seed or precompute for a stable render", ...at(t.pos) })
      } else if (NOW_OBJECTS.has(t.value) && member === "now") {
        warnings.push({ kind: "unguarded-timer", message: `\`${t.value}.now()\` reads wall-clock time — non-deterministic in a sealed render`, ...at(t.pos) })
      }
    }
  }

  return warnings
}

import type { PageMeta } from "entities/page"
import { lineColOf, SK, tokenize } from "./lexer"
import type { Tok } from "./lexer"

/** kit API versions this gate accepts (runtime-api §7.1). MVP ships version 1 only. */
const SUPPORTED_KIT_API_VERSIONS = new Set<number>([1])

/** A fatal page-contract violation (runtime-api §4). */
export interface PageContractError {
  readonly code: "NON_STATIC_META" | "MISSING_META_FIELD" | "UNSUPPORTED_KIT_API" | "MISSING_DEFAULT_EXPORT" | "NON_REATOM_DEFAULT"
  readonly message: string
  readonly line: number
  readonly column: number
}

/** The parsed page-contract outcome: fatal errors, and the static meta when it parsed. */
export interface PageContractResult {
  readonly errors: readonly PageContractError[]
  readonly meta: PageMeta | null
}

type Literal =
  | { readonly kind: "string"; readonly s: string }
  | { readonly kind: "number"; readonly n: number }
  | { readonly kind: "bool"; readonly b: boolean }
  | { readonly kind: "object"; readonly o: Record<string, Literal> }

/**
 * Parse ONE literal value at `i`. Returns the literal + the index after it, or
 * `invalid` for anything that is not a pure literal — a variable reference, a call,
 * a conditional, a template, or a concatenation — enforced by requiring the token
 * AFTER the primitive to be an entry terminator (`,` or `}`). (runtime-api §4.)
 */
function parseValue(toks: Tok[], i: number): { value: Literal; next: number } | "invalid" {
  const t = toks[i]
  if (t === undefined) return "invalid"
  const terminated = (next: number): boolean => {
    const n = toks[next]
    return n === undefined || n.kind === SK.CommaToken || n.kind === SK.CloseBraceToken
  }
  if (t.kind === SK.StringLiteral) return terminated(i + 1) ? { value: { kind: "string", s: t.value }, next: i + 1 } : "invalid"
  if (t.kind === SK.NumericLiteral) return terminated(i + 1) ? { value: { kind: "number", n: Number(t.value) }, next: i + 1 } : "invalid"
  if (t.kind === SK.MinusToken && toks[i + 1]?.kind === SK.NumericLiteral) {
    return terminated(i + 2) ? { value: { kind: "number", n: -Number(toks[i + 1]!.value) }, next: i + 2 } : "invalid"
  }
  if (t.kind === SK.TrueKeyword) return terminated(i + 1) ? { value: { kind: "bool", b: true }, next: i + 1 } : "invalid"
  if (t.kind === SK.FalseKeyword) return terminated(i + 1) ? { value: { kind: "bool", b: false }, next: i + 1 } : "invalid"
  if (t.kind === SK.OpenBraceToken) return parseObject(toks, i)
  return "invalid"
}

/**
 * Parse an object literal at OpenBrace `i` into a flat literal map, rejecting
 * spreads, computed keys, and any non-literal value. (runtime-api §4.)
 */
function parseObject(toks: Tok[], i: number): { value: Literal; next: number } | "invalid" {
  if (toks[i]?.kind !== SK.OpenBraceToken) return "invalid"
  const o: Record<string, Literal> = {}
  let j = i + 1
  while (j < toks.length) {
    const t = toks[j]!
    if (t.kind === SK.CloseBraceToken) return { value: { kind: "object", o }, next: j + 1 }
    if (t.kind === SK.DotDotDotToken || t.kind === SK.OpenBracketToken) return "invalid" // spread / computed key
    const key = t.kind === SK.Identifier || t.kind === SK.StringLiteral ? t.value : null
    if (key === null) return "invalid"
    if (toks[j + 1]?.kind !== SK.ColonToken) return "invalid" // shorthand / method — not a literal field
    const parsed = parseValue(toks, j + 2)
    if (parsed === "invalid") return "invalid"
    o[key] = parsed.value
    j = parsed.next
    const sep = toks[j]
    if (sep?.kind === SK.CommaToken) {
      j += 1
      continue
    }
    if (sep?.kind === SK.CloseBraceToken) return { value: { kind: "object", o }, next: j + 1 }
    return "invalid"
  }
  return "invalid"
}

const BINDING_KEYWORDS = new Set<number>(
  ["ConstKeyword", "LetKeyword", "VarKeyword"].map((name) => SK[name]).filter((k): k is number => k !== undefined),
)

/**
 * Validate the page contract from the source WITHOUT executing it (runtime-api §4):
 * `meta` is a direct `definePage({...})` call whose single argument is an object
 * literal of literals (no spreads / computed keys / variable refs / calls /
 * conditionals); the required fields are present with the right literal shape;
 * `kitApiVersion` is a supported integer; and there is a default `reatomComponent`
 * export. Returns the parsed `PageMeta` when the contract holds.
 */
export function checkPageContract(source: string): PageContractResult {
  const toks = tokenize(source)
  const errors: PageContractError[] = []
  const at = (pos: number) => lineColOf(source, pos)
  const err = (code: PageContractError["code"], message: string, pos: number) =>
    errors.push({ code, message, ...at(pos) })

  // --- locate `<binding> meta = definePage({ ... })` ---
  const metaIndex = toks.findIndex(
    (t, i) => t.kind === SK.Identifier && t.value === "meta" && i > 0 && BINDING_KEYWORDS.has(toks[i - 1]!.kind),
  )
  let meta: PageMeta | null = null
  if (metaIndex === -1) {
    err("NON_STATIC_META", "no `meta` binding found — a page must `export const meta = definePage({...})`", 0)
  } else if (
    toks[metaIndex + 1]?.kind !== SK.EqualsToken ||
    toks[metaIndex + 2]?.value !== "definePage" ||
    toks[metaIndex + 3]?.kind !== SK.OpenParenToken ||
    toks[metaIndex + 4]?.kind !== SK.OpenBraceToken
  ) {
    err("NON_STATIC_META", "`meta` must be a direct `definePage({...})` call with an object-literal argument", toks[metaIndex]!.pos)
  } else {
    const parsed = parseObject(toks, metaIndex + 4)
    const pos = toks[metaIndex + 4]!.pos
    if (parsed === "invalid") {
      err("NON_STATIC_META", "the `meta` object must contain only literal fields — no spreads, computed keys, variable references, calls, or conditionals", pos)
    } else if (parsed.value.kind === "object") {
      meta = validateMetaShape(parsed.value.o, pos, err)
    }
  }

  // --- default reatomComponent export ---
  const defIdx = toks.findIndex((t, i) => t.kind === SK.ExportKeyword && toks[i + 1]?.kind === SK.DefaultKeyword)
  if (defIdx === -1) {
    err("MISSING_DEFAULT_EXPORT", "a page must have a default export (its page component)", 0)
  } else {
    const after = toks[defIdx + 2]
    if (after?.value !== "reatomComponent" || toks[defIdx + 3]?.kind !== SK.OpenParenToken) {
      err("NON_REATOM_DEFAULT", "the default export must be a `reatomComponent(...)` (the page component)", toks[defIdx]!.pos)
    }
  }

  return { errors, meta }
}

/** Validate the parsed meta object's required fields + kit API support; return a PageMeta or null. */
function validateMetaShape(
  o: Record<string, Literal>,
  pos: number,
  err: (code: PageContractError["code"], message: string, pos: number) => void,
): PageMeta | null {
  const kit = o.kitApiVersion
  const title = o.title
  const theme = o.theme
  const size = o.minSize
  let ok = true
  const missing = (field: string) => {
    err("MISSING_META_FIELD", `meta.${field} is missing or not a valid literal`, pos)
    ok = false
  }
  if (kit?.kind !== "number" || !Number.isInteger(kit.n)) missing("kitApiVersion")
  if (title?.kind !== "string") missing("title")
  if (theme?.kind !== "string") missing("theme")
  const w = size?.kind === "object" ? size.o.w : undefined
  const h = size?.kind === "object" ? size.o.h : undefined
  if (w?.kind !== "number" || h?.kind !== "number") missing("minSize")

  if (kit?.kind === "number" && Number.isInteger(kit.n) && !SUPPORTED_KIT_API_VERSIONS.has(kit.n)) {
    err("UNSUPPORTED_KIT_API", `kitApiVersion ${kit.n} is not supported (this binary accepts ${[...SUPPORTED_KIT_API_VERSIONS].join(", ")})`, pos)
    ok = false
  }

  if (!ok || kit?.kind !== "number" || title?.kind !== "string" || theme?.kind !== "string" || w?.kind !== "number" || h?.kind !== "number") {
    return null
  }
  return { kitApiVersion: kit.n, title: title.s, minSize: { w: w.n, h: h.n }, theme: theme.s }
}

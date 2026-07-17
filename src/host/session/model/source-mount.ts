import * as errore from "errore"

import { ProtocolError } from "../../protocol"
import type { LoadPageArgs, LoadedPage, ValidatedPageMeta } from "../types"

/** The one legal authored module edge (runtime-api §2). */
const RUNTIME_SPECIFIER = "@termcraft/runtime"

/**
 * Specifiers `Bun.Transpiler.scanImports` reports as `require-call` for ANY
 * JSX-bearing `.tsx` source, regardless of what the page actually imports —
 * mechanical artifacts of the automatic JSX transform (empirically verified
 * against Bun 1.3.14: a JSX-free page produces no such records; a JSX-bearing
 * page always reports these two paths as `require-call`, in addition to
 * whatever it actually imports). They are exactly the two JSX-helper
 * specifiers the Task 1 resolver registers (`react/jsx-runtime` in prod mode,
 * `react/jsx-dev-runtime` in dev mode), plus the bare `react` require the dev
 * transform emits alongside them. Only the `require-call` kind is exempted —
 * an authored `import { useState } from "react"` reports as `import-statement`
 * for the same path (confirmed: `forbidden-react.tsx` reports BOTH an
 * `import-statement` "react" record for the authored import AND the phantom
 * `require-call` "react" record from the transform), so it is still caught.
 *
 * RESIDUAL GAP (defense-in-depth only): an author who writes a literal
 * `require("react")` / `require("react/jsx-runtime")` reports as `require-call`
 * for the same path as the phantom and is indistinguishable here — this scan would
 * let it through. Backstopped twice: the Gate's AST scan (phase 3) is the
 * AUTHORITATIVE allowlist and separates an author-written require node from a
 * transform-generated one; and the resolver never registers bare `react`, so in the
 * compiled binary such a require fails to resolve and the page cannot load (no react
 * access is gained). Closing it in the host would need an AST scan — deferred to
 * when the Gate's scanner (phase 3) can be shared.
 */
const COMPILER_INJECTED_JSX_SPECIFIERS = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"])

/** Lowercase-hex SHA-256 over the exact source bytes (host-supervision §3.1). */
export function computeSourceHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

/**
 * Re-scan a page's source for module edges before linking it (runtime-api §3.1,
 * §7.2 — "the host repeats the same import scan"). This is a defense-in-depth
 * backstop: the Gate's AST scan (phase 3) is authoritative, and the resolver
 * fails open, so a hand-edited canonical file or an old historical snapshot that
 * bypassed the Gate is caught here before any page code runs.
 *
 * Uses `Bun.Transpiler.scanImports`, which reports every code-loading edge —
 * `import-statement` (incl. `export … from`), `dynamic-import`, and `require` —
 * using Bun's real parser, not a regex. Any specifier other than the exact root
 * `@termcraft/runtime` is a `MALFORMED_PROTOCOL` violation, EXCEPT the compiler-
 * injected JSX-helper `require-call`s the automatic transform emits for every
 * JSX-bearing page (see `COMPILER_INJECTED_JSX_SPECIFIERS`) — those are not
 * something the author wrote, and are exactly what the Task 1 resolver exists
 * to serve. Type-only edges are erased by the transform and load no code, so
 * `scanImports` may omit them; the Gate's AST scan (phase 3) remains the
 * authority for the type-only rule.
 */
export function scanPageImports(sourceText: string): ProtocolError | void {
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  const imports = transpiler.scanImports(sourceText)
  for (const record of imports) {
    if (record.path === RUNTIME_SPECIFIER) continue
    if (record.kind === "require-call" && COMPILER_INJECTED_JSX_SPECIFIERS.has(record.path)) continue
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `forbidden import ${JSON.stringify(record.path)}; a page may import only "${RUNTIME_SPECIFIER}"`,
    })
  }
}

const malformed = (reason: string, cause?: unknown) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason, cause })

const sourceHashMismatch = (reason: string) =>
  new ProtocolError({ code: "SOURCE_HASH_MISMATCH", reason })

/**
 * Load and validate a page module (host-supervision §6.5-6.6, runtime-api §7.2).
 * The supervisor supplies the immutable path and the expected hash; the host
 * reads the bytes, recomputes and verifies the hash (a mismatch is fatal — no code
 * import — and typed SOURCE_HASH_MISMATCH per §12), rescans the import surface,
 * then dynamic-imports through the resolver (which MUST already be registered) and
 * structurally validates `meta` and the default export. Every boundary
 * (`Bun.file`, the UTF-8 decode, `import()`) is wrapped and carries its `cause`: a
 * read/decode/link failure becomes a typed `ProtocolError`, never a throw.
 */
export async function loadPage(args: LoadPageArgs): Promise<ProtocolError | LoadedPage> {
  const bytes = await Bun.file(args.sourcePath)
    .bytes()
    .catch((cause) => malformed(`cannot read source at ${args.sourcePath}`, cause))
  if (bytes instanceof ProtocolError) return bytes

  const sourceHash = computeSourceHash(bytes)
  if (sourceHash !== args.expectedSourceHash) {
    return sourceHashMismatch(
      `source hash mismatch: expected ${args.expectedSourceHash}, computed ${sourceHash}`,
    )
  }

  // §5: invalid UTF-8 is a protocol violation, not a throw. TextDecoder with
  // { fatal: true } throws on bad bytes, so wrap this sync boundary (errore rule 12,
  // { try, catch } options form per the installed errore@0.14.1).
  const sourceText = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => malformed("source is not valid UTF-8", cause),
  })
  if (sourceText instanceof ProtocolError) return sourceText

  const scanError = scanPageImports(sourceText)
  if (scanError instanceof ProtocolError) return scanError

  const linked = await import(args.sourcePath).catch((cause) =>
    malformed(`failed to link page at ${args.sourcePath}`, cause),
  )
  if (linked instanceof ProtocolError) return linked

  const meta = validateMeta((linked as { meta?: unknown }).meta)
  if (meta instanceof ProtocolError) return meta

  const component = (linked as { default?: unknown }).default
  if (typeof component !== "function") {
    return malformed("page default export must be a component function")
  }

  return { meta, component, sourceHash }
}

const THEME_MAX = 64
const TITLE_MAX = 256

/** Structurally validate the imported `meta` (runtime-api §4 static contract). */
function validateMeta(value: unknown): ProtocolError | ValidatedPageMeta {
  if (value === null || typeof value !== "object") {
    return malformed("page meta must be an object")
  }
  const meta = value as Record<string, unknown>
  const kitApiVersion = meta.kitApiVersion
  if (typeof kitApiVersion !== "number" || !Number.isSafeInteger(kitApiVersion) || kitApiVersion <= 0) {
    return malformed("meta.kitApiVersion must be a positive integer")
  }
  if (typeof meta.title !== "string" || meta.title.length === 0 || meta.title.length > TITLE_MAX) {
    return malformed("meta.title must be a bounded non-empty string")
  }
  if (typeof meta.theme !== "string" || meta.theme.length === 0 || meta.theme.length > THEME_MAX) {
    return malformed("meta.theme must be a bounded non-empty string")
  }
  const size = validateSize(meta.minSize)
  if (size instanceof ProtocolError) return size
  return { kitApiVersion, title: meta.title, minSize: size, theme: meta.theme }
}

const AXIS_MAX = 2048

function validateSize(value: unknown): ProtocolError | { w: number; h: number } {
  if (value === null || typeof value !== "object") return malformed("size must be an object")
  const size = value as Record<string, unknown>
  const w = size.w
  const h = size.h
  if (typeof w !== "number" || !Number.isSafeInteger(w) || w <= 0 || w > AXIS_MAX) {
    return malformed(`size.w must be a positive integer <= ${AXIS_MAX}`)
  }
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || h > AXIS_MAX) {
    return malformed(`size.h must be a positive integer <= ${AXIS_MAX}`)
  }
  return { w, h }
}

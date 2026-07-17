import { ProtocolError } from "../../protocol"

/** The one legal authored module edge (runtime-api §2). */
const RUNTIME_SPECIFIER = "@termcraft/runtime"

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
 * `@termcraft/runtime` is a `MALFORMED_PROTOCOL` violation. Type-only edges are
 * erased by the transform and load no code, so `scanImports` may omit them; the
 * Gate's AST scan (phase 3) remains the authority for the type-only rule.
 */
export function scanPageImports(sourceText: string): ProtocolError | void {
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  const imports = transpiler.scanImports(sourceText)
  for (const record of imports) {
    if (record.path !== RUNTIME_SPECIFIER) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `forbidden import ${JSON.stringify(record.path)}; a page may import only "${RUNTIME_SPECIFIER}"`,
      })
    }
  }
}

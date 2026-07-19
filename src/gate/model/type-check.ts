import os from "node:os"
import path from "node:path"
import * as errore from "errore"
import { API } from "typescript/unstable/sync"
import type { Diagnostic } from "typescript/unstable/sync"
import type { GateError } from "../types"
import { lineColOf } from "./lexer"

/**
 * The injected seams a type-checker needs (Spike C). `tscExePath` is a spawnable
 * `tsc.exe` on real disk (produced by `materializeCompiler`); `runtimeDts` is the
 * ambient `@termcraft/runtime` declaration TEXT — injected because phase 8 generates
 * the real one. The libs are NOT served here: they sit on disk next to the exe and
 * the Go compiler reads them itself (Spike C: "What the virtual FS is actually for").
 */
export interface TypeCheckerConfig {
  readonly tscExePath: string
  readonly runtimeDts: string
}

/**
 * A crashed / unavailable type-check subprocess (Spike C concern #4). The
 * `typescript/unstable/sync` API spawns the Go compiler over a named pipe and can
 * throw — including non-Error values at the Bun/Go boundary — so this wraps that
 * boundary. It NEVER means "the page is clean": a crash must surface as a fatal
 * `TYPE_CHECK_UNAVAILABLE` error, never as an empty diagnostic list.
 */
export class TypeCheckUnavailableError extends errore.createTaggedError({
  name: "TypeCheckUnavailableError",
  message: "the TypeScript type-check subprocess was unavailable",
}) {}

/** Synthetic (never-written-to-disk) file basenames served over the virtual FS (Spike C). */
const TSCONFIG_NAME = "tsconfig.termcraft.json"
const RUNTIME_DTS_NAME = "__termcraft_runtime__.d.ts"

/** Normalize a path to forward slashes so VFS lookups match the compiler's requests. */
function norm(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * The synthesized tsconfig (Spike C). `lib: ["esnext"]` is PINNED and load-bearing:
 * the default for `target: esnext` is `lib.esnext.full.d.ts`, which pulls in `dom` +
 * four other libs neither embedded nor wanted in a TUI (where `document` must not
 * exist). `strict` + `noEmit` + `moduleResolution: bundler` + `jsx: react-jsx`
 * mirror the runtime; `types: []` + `skipLibCheck: true` keep the check hermetic.
 */
function synthesizeTsconfig(candidatePath: string, runtimeDtsPath: string): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      jsx: "react-jsx",
      noEmit: true,
      target: "esnext",
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["esnext"],
      types: [],
      skipLibCheck: true,
    },
    files: [candidatePath, runtimeDtsPath],
  })
}

/**
 * Union of every diagnostic bucket, INCLUDING `getGlobalDiagnostics()` (Spike C, the
 * single most consequential rule): missing-lib / missing-global-type errors land ONLY
 * in the global bucket, so omitting it silently passes broken pages TypeScript proper
 * rejects. The union double-reports (a missing file surfaces in program + global at
 * once), which the caller dedupes on `(code, fileName, pos)`.
 */
function collectDiagnostics(program: {
  getConfigFileParsingDiagnostics(): readonly Diagnostic[]
  getProgramDiagnostics(): readonly Diagnostic[]
  getSyntacticDiagnostics(): readonly Diagnostic[]
  getSemanticDiagnostics(): readonly Diagnostic[]
  getGlobalDiagnostics(): readonly Diagnostic[]
}): readonly Diagnostic[] {
  return [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ]
}

/**
 * Map one diagnostic to a `GateError`. The API exposes a character-offset `pos` (not
 * a line/column), so line/column are derived via `lineColOf` — but only for a
 * diagnostic that belongs to the candidate file (a global/config diagnostic has no
 * candidate position, so its location is omitted).
 */
function toGateError(d: Diagnostic, ctx: { source: string; candidatePath: string; fileName: string }): GateError {
  const inCandidate = d.fileName !== undefined && norm(d.fileName) === ctx.candidatePath && d.pos >= 0
  const loc = inCandidate ? lineColOf(ctx.source, d.pos) : null
  return {
    kind: "type",
    code: `TS${d.code}`,
    message: d.text,
    ...(inCandidate ? { file: ctx.fileName } : {}),
    ...(loc !== null ? { line: loc.line, column: loc.column } : {}),
  }
}

/**
 * Dedupe on `(code, fileName, pos)` (Spike C: the union double-reports) and map each
 * surviving diagnostic to a `type`-kind `GateError`.
 */
function mapDiagnostics(diags: readonly Diagnostic[], ctx: { source: string; candidatePath: string; fileName: string }): GateError[] {
  const seen = new Set<string>()
  const out: GateError[] = []
  for (const d of diags) {
    const key = `${d.code}|${d.fileName ?? ""}|${d.pos}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(toGateError(d, ctx))
  }
  return out
}

/** True for a C0/C1 control codepoint (incl. ESC), which a bounded plain-text message must not carry. */
function isControlCodePoint(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/**
 * Bounded plain text with control bytes (incl. ESC / terminal sequences) replaced by
 * spaces and the whole string capped in length (host-supervision §13): a
 * `TYPE_CHECK_UNAVAILABLE` message may embed a compiler panic, which must never reach
 * a terminal as raw control sequences nor be unbounded.
 */
function boundedPlainText(raw: string): string {
  const sanitized = Array.from(raw, (ch) => (isControlCodePoint(ch.codePointAt(0) ?? 0) ? " " : ch)).join("")
  const collapsed = sanitized.replace(/\s+/g, " ").trim()
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed
}

/** Compose the fatal-error message for an unavailable compiler, bounded and sanitized. */
function unavailableMessage(error: TypeCheckUnavailableError): string {
  const cause: unknown = error.cause
  const reason = cause instanceof Error ? cause.message : String(cause)
  return boundedPlainText(`type check unavailable — the TypeScript compiler subprocess failed: ${reason}`)
}

/**
 * Run one hermetic type check over the candidate (Spike C). The API construction +
 * `updateSnapshot` + diagnostic retrieval are the subprocess boundary and can throw
 * (non-Error included), so the whole span is wrapped and any failure — including "no
 * project loaded" — becomes a `TypeCheckUnavailableError`. `api.close()` runs on every
 * path; a close failure is logged, never allowed to turn a successful check into a crash.
 */
function runTypeCheck(config: TypeCheckerConfig, source: string, fileName: string): GateError[] | TypeCheckUnavailableError {
  const cwd = norm(os.tmpdir())
  const candidatePath = norm(path.join(cwd, fileName))
  const tsconfigPath = `${cwd}/${TSCONFIG_NAME}`
  const runtimeDtsPath = `${cwd}/${RUNTIME_DTS_NAME}`
  const tsconfig = synthesizeTsconfig(candidatePath, runtimeDtsPath)

  // The virtual FS serves ONLY the three synthetic files — the tsconfig, the runtime
  // .d.ts, and the in-memory candidate. Everything else (the libs, next to the exe)
  // returns `undefined` = "read it off the real disk" (Spike C).
  const virtualFs = {
    readFile(name: string): string | null | undefined {
      const n = norm(name)
      if (n === tsconfigPath) return tsconfig
      if (n === runtimeDtsPath) return config.runtimeDts
      if (n === candidatePath) return source
      return undefined
    },
    fileExists(name: string): boolean | undefined {
      const n = norm(name)
      if (n === tsconfigPath || n === runtimeDtsPath || n === candidatePath) return true
      return undefined
    },
    realpath(p: string): string | undefined {
      const n = norm(p)
      if (n === tsconfigPath || n === runtimeDtsPath || n === candidatePath) return n
      return undefined
    },
  }

  // Raw try/catch at the subprocess boundary — NOT `errore.try`: the Bun/Go bridge can
  // throw NON-Error values, which `errore.try` re-throws rather than wrapping (Spike C
  // concern #4; the plan's global constraints). So this boundary catches `unknown`
  // itself and returns the failure as a domain-error value. `api.close()` runs on every
  // path; a close failure is logged, never allowed to turn a successful check into a crash.
  try {
    const api = new API({ cwd, tsserverPath: config.tscExePath, fs: virtualFs })
    try {
      const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] })
      const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0]
      if (project === undefined) return new TypeCheckUnavailableError({ cause: new Error("no project loaded from the synthesized tsconfig") })
      return mapDiagnostics(collectDiagnostics(project.program), { source, candidatePath, fileName })
    } finally {
      try {
        api.close()
      } catch (closeCause) {
        console.warn("type-check: api.close() failed:", closeCause instanceof Error ? closeCause.message : String(closeCause))
      }
    }
  } catch (cause) {
    return new TypeCheckUnavailableError({ cause })
  }
}

/**
 * Build the gate's `typeCheck` port (phase-3 T4, master §6.3 / Spike C): a checker
 * that type-checks one candidate page's source against the pinned esnext lib set and
 * the ambient runtime types, and returns fatal `type`-kind `GateError`s. A crashed or
 * unavailable compiler yields a single fatal `TYPE_CHECK_UNAVAILABLE` error — NEVER an
 * empty list — so "the checker never ran" can never read as "the page is clean".
 */
export function createTypeChecker(config: TypeCheckerConfig): (source: string, fileName: string) => Promise<GateError[]> {
  return async (source, fileName) => {
    const result = runTypeCheck(config, source, fileName)
    if (result instanceof Error) return [{ kind: "type", code: "TYPE_CHECK_UNAVAILABLE", message: unavailableMessage(result) }]
    return result
  }
}

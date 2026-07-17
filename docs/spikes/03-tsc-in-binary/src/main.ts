// Spike C probe: type-check an external page.tsx from inside a `bun build --compile`
// binary, with the lib .d.ts chain and @termcraft/runtime's types embedded.
//
// Usage: main.ts <file.tsx> [--timed]
//
// Departures from the plan's code, forced by the resolved typescript@7.0.2:
//   * `ts.createProgram` / `ts.JsxEmit` / `getPreEmitDiagnostics` do not exist. TS7 is
//     the native Go port; `import ts from "typescript"` yields {version, versionMajorMinor}.
//     The compiler API is `typescript/unstable/sync`, and it is project-based (needs a
//     tsconfig), not a loose file list.
//   * The lib .d.ts files are NOT in node_modules/typescript/lib. They ship in the
//     platform package @typescript/typescript-win32-x64/lib, next to tsc.exe.
//   * There is no `CompilerHost`. The TS7 analogue is the `fs` option: a virtual
//     filesystem whose callbacks the Go server delegates to. That is what serves the
//     embedded libs here.
//   * The Go compiler is a separate 24.5 MB native exe. Bun can embed it, but a
//     B:/~BUN/root/... path is not spawnable (uv_spawn ENOENT), so it must be
//     materialized to real disk once and cached.
import { API } from "typescript/unstable/sync"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { embeddedLibs } from "./libs.generated.ts"
import tscExePath from "../node_modules/@typescript/typescript-win32-x64/lib/tsc.exe" with { type: "file" }
import runtimeDtsPath from "./runtime.d.ts" with { type: "file" }

const TS_VERSION = "7.0.2"
const started = performance.now()

/** Embedded assets live at B:/~BUN/root/... inside a compiled binary. */
const isEmbedded = (p: string) => p.startsWith("B:/~BUN/") || p.startsWith("/$bunfs/")

/**
 * Materialize the Go compiler to real disk. Two separate reasons this is unavoidable:
 *
 *  1. uv_spawn cannot execute a B:/~BUN/root/... path (ENOENT) — the OS loader knows
 *     nothing about Bun's embedded VFS, so the exe needs a real path.
 *  2. tsgo ships as a `noembed` build: its libs are NOT compiled into the Go binary.
 *     At startup, before any API/virtual-FS is wired up, `bundled.LibPath()` stats
 *     `lib.d.ts` next to the exe and panics "this executable may be misplaced" if it
 *     is missing. That check is a real os.Stat in another process — a JS virtual FS
 *     cannot answer it. So the lib files must sit on disk next to the exe too.
 *
 * Cached by version+size, so only the first run of a given build pays for it.
 */
function materializeCompiler(): { exe: string; extracted: boolean } {
  if (!isEmbedded(tscExePath)) return { exe: tscExePath, extracted: false }
  const dir = path.join(os.tmpdir(), `termcraft-tsc-${TS_VERSION}`)
  const exe = path.join(dir, "tsc.exe")
  const want = fs.statSync(tscExePath).size
  if (fs.existsSync(exe) && fs.statSync(exe).size === want) return { exe, extracted: false }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(exe, fs.readFileSync(tscExePath))
  // The startup sentinel and the lib chain must live next to the exe on real disk.
  for (const [name, embeddedPath] of Object.entries(embeddedLibs)) {
    fs.writeFileSync(path.join(dir, name), fs.readFileSync(embeddedPath))
  }
  return { exe, extracted: true }
}

const { exe, extracted } = materializeCompiler()
const extractedAt = performance.now()

const file = path.resolve(process.argv[2]!).replace(/\\/g, "/")
const dir = path.dirname(file)

// Synthesized, never written to disk — served from the virtual FS below. This is the
// spec's promise: the project folder never grows a package.json or a tsconfig.
const tsconfigPath = `${dir}/tsconfig.termcraft.json`
const runtimeDts = `${dir}/__termcraft_runtime__.d.ts`
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    jsx: "react-jsx",
    noEmit: true,
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    lib: ["esnext"], // pin the lib set to the chain we embedded; avoids pulling in DOM
    types: [],
    skipLibCheck: true,
  },
  files: [file, runtimeDts],
})

/** Read an embedded asset synchronously. Bun's fs shim understands B:/~BUN/root paths. */
const readEmbedded = (p: string) => fs.readFileSync(p, "utf8")

/**
 * The virtual filesystem — the TS7 replacement for a custom CompilerHost.
 *
 * The Go server asks for lib files at a path derived from the compiler exe's own
 * directory (e.g. <exeDir>/lib.es5.d.ts). Since we moved the exe to a temp dir that
 * has no lib files next to it, we match on basename and serve embedded content.
 *
 * Contract (from dist/api/fs.d.ts):
 *   readFile: string => content | null (does not exist) | undefined (fall back to real FS)
 */
const virtualFs = {
  readFile(fileName: string): string | null | undefined {
    if (fileName === tsconfigPath) return tsconfig
    if (fileName === runtimeDts) return readEmbedded(runtimeDtsPath)
    const base = path.basename(fileName)
    if (embeddedLibs[base]) return readEmbedded(embeddedLibs[base]!)
    return undefined // the page itself, and anything else, comes from the real disk
  },
  fileExists(fileName: string): boolean | undefined {
    if (fileName === tsconfigPath || fileName === runtimeDts) return true
    if (embeddedLibs[path.basename(fileName)]) return true
    return undefined
  },
  realpath(p: string): string | undefined {
    if (p === tsconfigPath || p === runtimeDts) return p
    if (embeddedLibs[path.basename(p)]) return p
    return undefined
  },
}

const api = new API({ cwd: dir, tsserverPath: exe, fs: virtualFs })

function check(invalidate = false) {
  const snapshot = api.updateSnapshot({
    openProjects: [tsconfigPath],
    // A real Gate retry re-checks an *edited* file. Without invalidation the server
    // returns the cached snapshot and the "re-check" is a meaningless sub-ms cache hit.
    ...(invalidate ? { fileChanges: { invalidateAll: true as const } } : {}),
  })
  const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0]
  if (!project) return null
  return [
    ...project.program.getConfigFileParsingDiagnostics(),
    ...project.program.getProgramDiagnostics(),
    ...project.program.getSyntacticDiagnostics(),
    ...project.program.getSemanticDiagnostics(),
  ]
}

// --repeat N: re-check N times against ONE held-open API, to measure what the Gate
// would pay per retry if it keeps the compiler process alive instead of respawning.
const repeatArg = process.argv.indexOf("--repeat")
if (repeatArg !== -1) {
  const n = Number(process.argv[repeatArg + 1] ?? 4)
  const laps: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    check(i > 0) // lap 0 is the initial check; later laps invalidate, as a retry would
    laps.push(+(performance.now() - t0).toFixed(1))
  }
  console.error(JSON.stringify({ heldOpenApiLapsMs: laps }))
  api.close()
  process.exit(0)
}

const diags = check()
if (!diags) {
  console.log(JSON.stringify({ error: "no project loaded" }))
  api.close()
  process.exit(1)
}

console.log(
  JSON.stringify(
    diags.map((d) => ({
      code: d.code,
      message: d.text,
      ...(d.relatedInformation?.length ? { related: d.relatedInformation.map((r) => r.text) } : {}),
    })),
    null,
    2,
  ),
)

if (process.argv.includes("--timed")) {
  const done = performance.now()
  console.error(
    JSON.stringify({
      totalMs: +(done - started).toFixed(1),
      compilerExtractMs: +(extractedAt - started).toFixed(1),
      checkMs: +(done - extractedAt).toFixed(1),
      extractedThisRun: extracted,
      compilerExe: exe,
      embeddedLibCount: Object.keys(embeddedLibs).length,
    }),
  )
}

api.close()

// Spike C probe: type-check an external page.tsx from inside a `bun build --compile`
// binary, with the lib .d.ts chain and @termcraft/runtime's types embedded.
//
// Usage: main.ts <file.tsx>
//          [--timed]            in-process timing breakdown on stderr
//          [--trace-fs]         count the FS callbacks the Go server delegates to JS
//          [--vfs-libs]         also serve libs over the virtual FS (redundant; measurable)
//          [--buckets]          label each diagnostic with the API bucket that reported it
//          [--break-lib <name>] hide one lib from the compiler, to see how a broken
//                               reference chain actually surfaces
//          [--retry-sim N]      N Gate retries against one held-open API, mutating the
//                               file between laps so each lap is a real re-check
//
// Departures from the plan's code, forced by the resolved typescript@7.0.2:
//   * `ts.createProgram` / `ts.JsxEmit` / `getPreEmitDiagnostics` do not exist. TS7 is
//     the native Go port; `import ts from "typescript"` yields {version, versionMajorMinor}.
//     The compiler API is `typescript/unstable/sync`, and it is project-based (needs a
//     tsconfig), not a loose file list.
//   * The lib .d.ts files are NOT in node_modules/typescript/lib. They ship in the
//     platform package @typescript/typescript-win32-x64/lib, next to tsc.exe.
//   * There is no `CompilerHost`. The TS7 analogue is the `fs` option: a virtual
//     filesystem whose callbacks the Go server delegates to. Its ESSENTIAL job here is
//     the synthesized tsconfig and the runtime .d.ts — NOT the libs (see virtualFs).
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

const argv = process.argv
const has = (f: string) => argv.includes(f)

/** Serve lib .d.ts over the virtual FS. Redundant by construction — see virtualFs. */
const SERVE_LIBS_OVER_VFS = has("--vfs-libs")

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
 * Cached by version + exe size + presence of every one of the 88 libs, so a half-cleaned
 * temp dir re-extracts instead of reproducing the noembed panic. That completeness check
 * costs ~91 syscalls per run instead of 3 (see FINDINGS: warm compilerExtractMs went from
 * ~0.7ms to ~3-8ms because of it) — trivial against a ~170ms check, but not free.
 */
function materializeCompiler(): { exe: string; extracted: boolean } {
  if (!isEmbedded(tscExePath)) return { exe: tscExePath, extracted: false }
  const dir = path.join(os.tmpdir(), `termcraft-tsc-${TS_VERSION}`)
  const exe = path.join(dir, "tsc.exe")
  const libNames = Object.keys(embeddedLibs)
  const cacheComplete =
    fs.existsSync(exe) &&
    fs.statSync(exe).size === fs.statSync(tscExePath).size &&
    libNames.every((n) => fs.existsSync(path.join(dir, n)))
  if (cacheComplete) return { exe, extracted: false }
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

const file = path.resolve(argv[2]!).replace(/\\/g, "/")
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
    // Pins the lib set to the chain we embedded. Without this the default for
    // target:esnext is lib.esnext.full.d.ts, which references six libs: esnext (kept)
    // plus dom, scripthost, webworker.importscripts, dom.iterable and dom.asynciterable
    // — 2,361,763 B (~2.25 MiB) that is neither embedded here nor wanted in a TUI, where
    // `document` should not exist. (Their own refs, es2015 and es2018.asynciterable, are
    // already in the esnext chain, so nothing further would be pulled in.)
    lib: ["esnext"],
    types: [],
    skipLibCheck: true,
  },
  files: [file, runtimeDts],
})

/** Read an embedded asset synchronously. Bun's fs shim understands B:/~BUN/root paths. */
const readEmbedded = (p: string) => fs.readFileSync(p, "utf8")

const fsHits: Record<string, number> = {}
const bump = (k: string) => {
  fsHits[k] = (fsHits[k] ?? 0) + 1
}

/**
 * DISTINCT lib basenames the compiler asked for. This is the cross-check that proves the
 * embedded chain is complete, so it must count names, not calls: a counter would report
 * the same 87 whether the compiler asked for 87 different libs or one lib 87 times.
 * No fixture can prove completeness (a broken link is silent unless the page uses that
 * lib), which is what makes this the load-bearing evidence.
 */
const libsAsked = new Set<string>()
const LIB_RE = /^lib\..*\.d\.ts$/

/**
 * The virtual filesystem — the TS7 replacement for a custom CompilerHost.
 *
 * What it is ESSENTIAL for: the synthesized tsconfig and the runtime .d.ts. Neither
 * exists on disk, and neither may ever be written there — that is exactly the spec's
 * "the project folder never grows a package.json" promise, and the VFS is what keeps it.
 *
 * What it is NOT needed for: the lib files. materializeCompiler() has already written
 * all 88 of them next to the exe on real disk (it must — the Go startup check demands
 * it), so the Go process finds them by itself. Serving them here as well is redundant;
 * `--vfs-libs` re-enables it only so the cost can be measured.
 *
 * Note the callbacks fire for lib files either way: once an `fs` is registered the Go
 * server routes its FS access through it, and returning `undefined` merely says "fall
 * back to the real disk". So the choice is not "RPC vs no RPC" — it is "answer with
 * 621 KB of content over RPC" vs "answer undefined and let Go read the file".
 *
 * Contract (from dist/api/fs.d.ts):
 *   readFile: string => content | null (does not exist) | undefined (fall back to real FS)
 */

// --break-lib <lib.x.d.ts>: hide one lib from the compiler (null = "does not exist", no
// real-FS fallback), to see how a broken link in the reference chain actually surfaces.
const breakArg = argv.indexOf("--break-lib")
const brokenLib = breakArg !== -1 ? argv[breakArg + 1] : undefined

const virtualFs = {
  readFile(fileName: string): string | null | undefined {
    bump("readFile")
    const base = path.basename(fileName)
    // Recorded before any branching and independently of --vfs-libs, so the cross-check
    // measures what the compiler ASKED for, not what this probe chose to answer with.
    if (LIB_RE.test(base)) libsAsked.add(base)
    if (brokenLib && base === brokenLib) return null
    if (fileName === tsconfigPath) return tsconfig
    if (fileName === runtimeDts) return readEmbedded(runtimeDtsPath)
    if (SERVE_LIBS_OVER_VFS && embeddedLibs[base]) {
      bump("readFile:lib")
      return readEmbedded(embeddedLibs[base]!)
    }
    return undefined // libs, the page itself, and anything else come from the real disk
  },
  fileExists(fileName: string): boolean | undefined {
    bump("fileExists")
    if (fileName === tsconfigPath || fileName === runtimeDts) return true
    return undefined
  },
  realpath(p: string): string | undefined {
    bump("realpath")
    if (p === tsconfigPath || p === runtimeDts) return p
    return undefined
  },
}

const api = new API({ cwd: dir, tsserverPath: exe, fs: virtualFs })

/**
 * The replacement for `getPreEmitDiagnostics`. Note `getGlobalDiagnostics()`: the real
 * getPreEmitDiagnostics includes global diagnostics, so this union must too. Errors like
 * "Cannot find global type 'Array'" — the missing-lib signature this spike exists to
 * detect — are non-file-specific and land there and nowhere else. A Gate that omits it
 * silently passes pages TypeScript proper rejects.
 */
function check(changed?: string) {
  const snapshot = api.updateSnapshot({
    openProjects: [tsconfigPath],
    ...(changed ? { fileChanges: { changed: [changed] } } : {}),
  })
  const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0]
  if (!project) return null
  const p = project.program
  const buckets = {
    config: p.getConfigFileParsingDiagnostics(),
    program: p.getProgramDiagnostics(),
    syntactic: p.getSyntacticDiagnostics(),
    semantic: p.getSemanticDiagnostics(),
    global: p.getGlobalDiagnostics(),
  }
  return Object.entries(buckets).flatMap(([bucket, ds]) => ds.map((d) => ({ bucket, d })))
}

type Diag = { code: number; text: string; relatedInformation?: readonly { text: string }[] }

const shape = ({ bucket, d }: { bucket: string; d: Diag }) => ({
  code: d.code,
  message: d.text,
  ...(d.relatedInformation?.length ? { related: d.relatedInformation.map((r) => r.text) } : {}),
  // Which of the five getPreEmitDiagnostics-equivalent buckets reported it. Shown only
  // under --buckets: it is probe instrumentation, not part of the diagnostic.
  ...(has("--buckets") ? { bucket } : {}),
})

// --retry-sim N: what a real Gate retry costs. Unlike a bare re-check, this MUTATES the
// file between laps and reports the diagnostic count per lap, so the numbers cannot be
// explained by a content-keyed cache: if the count does not flip, the re-check did not
// happen.
const simArg = argv.indexOf("--retry-sim")
if (simArg !== -1) {
  const n = Number(argv[simArg + 1] ?? 4)
  const original = fs.readFileSync(file, "utf8")
  const goodSrc = original
  // Must mutate the `title` INSIDE the Panel(...) call — the `meta` object's title is
  // untyped, so making it a number is legal and the diagnostics would never flip.
  const badSrc = original.replace(/(Panel\(\{[^}]*?title:\s*)"[^"]*"/, "$1" + "42")
  if (goodSrc === badSrc) {
    console.error(JSON.stringify({ error: "retry-sim found no Panel({... title: \"...\"}) to mutate" }))
    api.close()
    process.exit(1)
  }
  const laps: { ms: number; diags: number }[] = []
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(file, i % 2 === 1 ? badSrc : goodSrc)
    const t0 = performance.now()
    const d = check(file)
    laps.push({ ms: +(performance.now() - t0).toFixed(1), diags: d?.length ?? -1 })
  }
  fs.writeFileSync(file, original)
  console.error(JSON.stringify({ retrySimLaps: laps }))
  api.close()
  process.exit(0)
}

const diags = check()
if (!diags) {
  console.log(JSON.stringify({ error: "no project loaded" }))
  api.close()
  process.exit(1)
}

console.log(JSON.stringify(diags.map(shape), null, 2))

if (has("--timed")) {
  const done = performance.now()
  console.error(
    JSON.stringify({
      totalMs: +(done - started).toFixed(1),
      compilerExtractMs: +(extractedAt - started).toFixed(1),
      checkMs: +(done - extractedAt).toFixed(1),
      extractedThisRun: extracted,
      serveLibsOverVfs: SERVE_LIBS_OVER_VFS,
      embeddedLibCount: Object.keys(embeddedLibs).length,
    }),
  )
}

if (has("--trace-fs")) {
  const embedded = Object.keys(embeddedLibs)
  const asked = [...libsAsked].sort()
  console.error(
    JSON.stringify({
      fsCallbackHits: fsHits,
      // The completeness cross-check: distinct lib names asked for vs embedded.
      distinctLibsAsked: asked.length,
      embeddedLibCount: embedded.length,
      askedButNotEmbedded: asked.filter((n) => !embeddedLibs[n]), // must be empty
      embeddedButNeverAsked: embedded.filter((n) => !libsAsked.has(n)),
    }),
  )
}
if (has("--list-libs-asked")) console.error(JSON.stringify([...libsAsked].sort(), null, 2))

api.close()

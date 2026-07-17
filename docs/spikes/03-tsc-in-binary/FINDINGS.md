# Spike C — TypeScript check inside the compiled binary

## The question

Can the TypeScript compiler type-check an external `page.tsx` from inside a
`bun build --compile` binary on Windows, with the lib `.d.ts` files and
`@termcraft/runtime`'s types embedded — and fast enough to sit inside a turn?

Why it matters: the Gate is the correctness wall. §4.2: *"correctness comes from the
gate only accepting what landed in staging and validated."* No type check inside the
binary, no Gate as specified.

## The answer

Verdict: YES-WITH-FALLBACK

Latency: 277 ms

That latency is one cold check: the first-ever run, wall-clock, including a one-time
24.5 MB compiler extraction. Every check after it is **~149 ms** wall-clock (**~47 ms**
for the check itself in-process), and a Gate that holds the compiler open pays **~11 ms**
per retry. Full numbers under "Latency — half the finding".

The check works, and it works in a directory with no `node_modules`, no `package.json`
and no `tsconfig.json` — the spec's promise holds. It is `YES-WITH-FALLBACK`, not `YES`,
for one reason: **the binary cannot do the check inside itself.** The TypeScript compiler
is now a separate 24.5 MB native Go executable, and two independent hard walls force it
onto the real filesystem before it can run:

1. `uv_spawn` cannot execute a `B:/~BUN/root/...` path — the OS loader knows nothing
   about Bun's embedded VFS.
2. `tsgo` ships as a **`noembed`** build: its libs are not compiled into the Go binary.
   At startup — *before* any API or virtual FS exists — it stats `lib.d.ts` next to its
   own exe and panics `this executable may be misplaced` if it is absent. That check is a
   real `os.Stat` in another process, so a JS virtual FS cannot answer it.

So the working shape is: embed the compiler and the libs, **extract them once** to a
cached temp dir, spawn the compiler, and serve the *synthesized* config and the runtime
types over the virtual FS. The extraction is the fallback. It is one-time per version,
costs 57 ms, and after it the product is fully self-contained from the user's side —
but the binary does write a 24.5 MB exe to `%TEMP%` on first use, and that is a fact
Task 4 must weigh, not a detail.

### The plan's premise did not survive contact

The plan is built on `ts.createProgram` + a custom `CompilerHost` serving lib files.
**None of those three things exist in the resolved version.** `bun add typescript`
resolves to **7.0.2**, the native Go port. See "Where the plan did not match reality".

## Resolved version (verbatim from `bun.lock`)

```
"typescript": ["typescript@7.0.2", "", { "optionalDependencies": { "@typescript/typescript-aix-ppc64": "7.0.2", ... "@typescript/typescript-win32-x64": "7.0.2" }, "bin": { "tsc": "bin/tsc" } }, "sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA=="],
```

```
"@typescript/typescript-win32-x64": ["@typescript/typescript-win32-x64@7.0.2", "", { "os": "win32", "cpu": "x64" }, "sha512-0BQ3HkAHHlKLSp1qRvf3SUhGpGsDuhB/jgFw75guyqbxJqEaS0Cw/VFO8i2nHglJUzQCRtMMR/IBAKE3ETMC4g=="],
```

Environment: Windows 11 Pro 10.0.26200, `bun` 1.3.14, `tsc.exe` 24,520,544 bytes,
`probe.exe` 124,059,136 bytes.

## Verbatim output — both fixtures, both modes

### Under `bun run` (baseline, default host, real filesystem)

```
$ bun run src/baseline.ts fixture/good.tsx
[]

$ bun run src/baseline.ts fixture/bad.tsx
[
  {
    "code": 2322,
    "message": "Type 'number' is not assignable to type 'string'."
  }
]
```

### Under `bun run` (the real probe: embedded libs + virtual FS)

```
$ bun run src/main.ts fixture/good.tsx
[]

$ bun run src/main.ts fixture/bad.tsx
[
  {
    "code": 2322,
    "message": "Type 'number' is not assignable to type 'string'.",
    "related": [
      "The expected type comes from property 'title' which is declared here on type '{ id: string; title: string; }'"
    ]
  }
]
```

### Under `--compile`

```
$ bun build --compile src/main.ts --outfile probe.exe
  [37ms]  bundle  148 modules
 [480ms] compile  probe.exe

$ ./probe.exe fixture/good.tsx
[]

$ ./probe.exe fixture/bad.tsx
[
  {
    "code": 2322,
    "message": "Type 'number' is not assignable to type 'string'.",
    "related": [
      "The expected type comes from property 'title' which is declared here on type '{ id: string; title: string; }'"
    ]
  }
]
```

### Under `--compile`, in a clean room — the finding that matters

`node_modules` sitting next to the probe would mask a silent fallback to the real
compiler installation, which is the "checker that never ran" trap in another guise. So
the binary was copied to a directory containing nothing but itself and two `.tsx` files,
and the extraction cache was deleted first:

```
$ find . -type f | sort
./pages/foo/bad.tsx
./pages/foo/good.tsx
./probe.exe

$ ./probe.exe pages/foo/good.tsx
[]

$ ./probe.exe pages/foo/bad.tsx
[
  {
    "code": 2322,
    "message": "Type 'number' is not assignable to type 'string'.",
    "related": [
      "The expected type comes from property 'title' which is declared here on type '{ id: string; title: string; }'"
    ]
  }
]
```

Both halves of the verdict hold: clean on `good.tsx`, correct error on `bad.tsx`,
with no `node_modules`, no `package.json`, no `tsconfig.json` anywhere.

### Controls — proof the check is real

`bad.tsx` proves the checker runs. Two further controls prove the *embedded lib chain*
is loaded and load-bearing, rather than silently skipped:

```
$ cat pages/foo/libcheck.tsx
export const m: Map<string, number> = new Map()
export const p: Promise<string> = Promise.resolve("x")
export const f: Float16Array = new Float16Array(1)
export const bad: number = "not a number"

$ ./probe.exe pages/foo/libcheck.tsx
[
  {
    "code": 2322,
    "message": "Type 'string' is not assignable to type 'number'."
  }
]
```

`Map` and `Promise` (from `lib.es2015.*`) and `Float16Array` (from
`lib.es2025.float16.d.ts`, deep in the chain) all resolve — so the embedded libs are
genuinely serving; a missing chain would have produced `Cannot find name 'Map'`. And the
one deliberate error is still caught.

Second control — the plan's `bad.tsx` is described as *"`title` is a number where a
string is declared, **and `id` is missing**"*, but only the `title` error is reported.
That is not a hole in the checker; it is TypeScript's object-literal elaboration
reporting the more specific property mismatch and stopping. The missing property is
caught independently:

```
$ cat pages/foo/missingid.tsx
import { Panel } from "@termcraft/runtime"
export default function Page(): string {
  return Panel({ title: "ok" })
}

$ ./probe.exe pages/foo/missingid.tsx
[
  {
    "code": 2741,
    "message": "Property 'id' is missing in type '{ title: string; }' but required in type '{ id: string; title: string; }'.",
    "related": [
      "'id' is declared here."
    ]
  }
]
```

## Latency — half the finding

Three warm runs, `performance.now()` inside the compiled binary, clean room:

| run | totalMs | compilerExtractMs | checkMs |
|-----|---------|-------------------|---------|
| 1   | 49.9    | 0.8               | 49.1    |
| 2   | 46.5    | 0.6               | 45.9    |
| 3   | 47.7    | 0.6               | 47.1    |

`performance.now()` starts inside the process, so it cannot see the binary's own startup.
Wall-clock is what the user actually waits:

| condition                               | wall-clock             |
|-----------------------------------------|------------------------|
| first-ever run (extracts exe + 88 libs) | **277 ms**             |
| every run after (cache warm)            | **148 / 150 / 149 ms** |

First-ever run, broken down: `{"totalMs":193.5,"compilerExtractMs":57.3,"checkMs":136.3,"extractedThisRun":true}`
— the 24.5 MB extraction costs 57 ms and happens once per version, not once per check.

### What it composes to across a turn

The Gate runs on every attempt and §9 allows up to 3 retries, so the user waits for this
up to **four times per turn**:

- **One binary invocation per attempt (as probed): 4 × ~149 ms ≈ 600 ms per turn.**
  Add ~130 ms once, on the very first check after an install/upgrade.
- **Holding the compiler open across attempts: ≈ 60 ms per turn.** The TS7 API is a
  long-lived server, so the Gate can keep one `API` instance alive. Measured, with
  invalidation between laps so each lap is a real re-check and not a cache hit:
  `{"heldOpenApiLapsMs":[24.7,10.8,12.1,10.6]}` — ~25 ms for the first check, ~11 ms per
  retry.

Either way this is a `YES` at ~600 ms per turn, not a `YES` at 8 seconds, and there is a
10× headroom option in hand if the Gate ever needs it. Latency is not a risk for this
design.

## The embedded lib file list — 88 files

**How it was determined.** Not by guessing: `lib.esnext.d.ts` is the root of a chain of
`/// <reference lib="..." />` directives, and a missing link surfaces as a confusing
`cannot find name X` rather than an honest "file not found". `src/gen-libs.ts` walks
those directives transitively over the *installed* platform package and emits one Bun
file-import per file (`src/libs.generated.ts`).

**Cross-checked against runtime.** Instrumenting the virtual FS showed the Go compiler
asking for exactly **87** `lib.*.d.ts` files — the same 87 the static walk produced. The
88th is `lib.d.ts`, which the chain does *not* reference; it is the startup sentinel the
Go binary stats to decide whether it has been misplaced. Its own chain
(`es5`/`dom`/`webworker`/`scripthost`) is deliberately **not** followed: `lib: ["esnext"]`
overrides the default lib, so `lib.d.ts` is never parsed and 3.1 MB of `lib.dom.d.ts` +
`lib.webworker.d.ts` stay out of the binary.

Chain from `lib.esnext.d.ts` (87 files, 621,294 bytes), in dependency order:

```
lib.decorators.d.ts              lib.es2019.array.d.ts            lib.es2023.d.ts
lib.decorators.legacy.d.ts       lib.es2019.object.d.ts           lib.es2024.arraybuffer.d.ts
lib.es5.d.ts                     lib.es2019.string.d.ts           lib.es2024.collection.d.ts
lib.es2015.core.d.ts             lib.es2019.symbol.d.ts           lib.es2024.object.d.ts
lib.es2015.collection.d.ts       lib.es2019.intl.d.ts             lib.es2024.promise.d.ts
lib.es2015.symbol.d.ts           lib.es2019.d.ts                  lib.es2024.regexp.d.ts
lib.es2015.iterable.d.ts         lib.es2020.intl.d.ts             lib.es2024.sharedmemory.d.ts
lib.es2015.generator.d.ts        lib.es2020.bigint.d.ts           lib.es2024.string.d.ts
lib.es2015.promise.d.ts          lib.es2020.date.d.ts             lib.es2024.d.ts
lib.es2015.proxy.d.ts            lib.es2020.number.d.ts           lib.es2025.collection.d.ts
lib.es2015.reflect.d.ts          lib.es2020.promise.d.ts          lib.es2025.float16.d.ts
lib.es2015.symbol.wellknown.d.ts lib.es2020.sharedmemory.d.ts     lib.es2025.intl.d.ts
lib.es2015.d.ts                  lib.es2020.symbol.wellknown.d.ts lib.es2025.iterator.d.ts
lib.es2016.array.include.d.ts    lib.es2020.string.d.ts           lib.es2025.promise.d.ts
lib.es2016.intl.d.ts             lib.es2020.d.ts                  lib.es2025.regexp.d.ts
lib.es2016.d.ts                  lib.es2021.promise.d.ts          lib.es2025.d.ts
lib.es2017.arraybuffer.d.ts      lib.es2021.string.d.ts           lib.esnext.temporal.d.ts
lib.es2017.date.d.ts             lib.es2021.weakref.d.ts          lib.esnext.intl.d.ts
lib.es2017.intl.d.ts             lib.es2021.intl.d.ts             lib.esnext.collection.d.ts
lib.es2017.object.d.ts           lib.es2021.d.ts                  lib.esnext.decorators.d.ts
lib.es2017.sharedmemory.d.ts     lib.es2022.array.d.ts            lib.esnext.disposable.d.ts
lib.es2017.string.d.ts           lib.es2022.error.d.ts            lib.esnext.array.d.ts
lib.es2017.typedarrays.d.ts      lib.es2022.intl.d.ts             lib.esnext.error.d.ts
lib.es2017.d.ts                  lib.es2022.object.d.ts           lib.esnext.sharedmemory.d.ts
lib.es2018.asynciterable.d.ts    lib.es2022.regexp.d.ts           lib.esnext.typedarrays.d.ts
lib.es2018.asyncgenerator.d.ts   lib.es2022.string.d.ts           lib.esnext.date.d.ts
lib.es2018.promise.d.ts          lib.es2022.d.ts                  lib.esnext.d.ts
lib.es2018.regexp.d.ts           lib.es2023.array.d.ts
lib.es2018.intl.d.ts             lib.es2023.collection.d.ts
lib.es2018.d.ts                  lib.es2023.intl.d.ts
```

Plus the startup sentinel: `lib.d.ts`. **Total: 88.**

## Where the plan did not match reality

The plan's snippets were written against TypeScript 5.x. `bun add typescript` resolves to
**7.0.2**, the native Go port, and essentially every load-bearing assumption changed.

**1. `ts.createProgram` does not exist.** The plan's Step 3 code, run verbatim
(`src/plan-verbatim.ts`, kept as evidence):

```
$ bun run src/plan-verbatim.ts fixture/good.tsx
8 |   jsx: ts.JsxEmit.ReactJSX,
              ^
TypeError: undefined is not an object (evaluating 'ts.JsxEmit.ReactJSX')
      at C:\Users\Khmil\RustProjects\termcraft\docs\spikes\03-tsc-in-binary\src\plan-verbatim.ts:8:11
```

The `typescript` package's main export is now `./lib/version.cjs` — nothing else:

```
$ bun -e 'import ts from "typescript"; console.log(Object.keys(ts), typeof ts.createProgram)'
[ "version", "versionMajorMinor" ] undefined
```

*Corrected to:* `import { API } from "typescript/unstable/sync"`, which is project-based
(`updateSnapshot({ openProjects: [tsconfig] })` -> `project.program.getSemanticDiagnostics()`)
and takes a **tsconfig**, not a loose file list. `getPreEmitDiagnostics` has no analogue;
the probe unions config-parsing + program + syntactic + semantic diagnostics.

**2. The lib `.d.ts` files are not where the plan points.** The plan imports
`../node_modules/typescript/lib/lib.esnext.d.ts`. That path **does not exist** — TS7's
`node_modules/typescript/lib/` holds only `getExePath.js`, `tsc.js`, `version.cjs`.
*Corrected to:* `../node_modules/@typescript/typescript-win32-x64/lib/lib.esnext.d.ts` —
the libs ship in the per-platform package, next to `tsc.exe`. **This makes the import
path OS/arch-dependent**, which the plan's design did not anticipate.

**3. There is no `CompilerHost`, so `getSourceFile`/`fileExists`/`readFile` cannot be
overridden.** *Corrected to:* the TS7 analogue, `new API({ fs })` — a virtual filesystem
the Go server delegates back to over RPC (`readFile`, `fileExists`, `directoryExists`,
`getAccessibleEntries`, `realpath`). Confirmed empirically: with a virtual FS registered,
the server issued 92 `readFile`, 87 `realpath`, 23 `directoryExists` and 6 `fileExists`
callbacks for one check — including all 87 lib reads.

**4. The compiler is a separate native process, which the plan does not model at all.**
`tsc.exe` is 24.5 MB of Go, spawned and driven over JSON-RPC/msgpack. This is the same
class of risk as the plan's Known Risk #2 (OpenTUI's native Zig core), but for the Gate —
and it was not on the list.

**5. `bun build --compile` cannot spawn an embedded exe.** Embedding works and
`fs.readFileSync` reads embedded paths fine, but:

```
libEsnextPath: B:/~BUN/root/lib.esnext.d-5em6wgcn.ts
tscExePath: B:/~BUN/root/tsc-kmfg705c.exe
readFileSync(lib) OK, bytes: 1244
statSync(exe) OK, size: 24520544
spawn exe FAILED: Error: ENOENT: no such file or directory, uv_spawn 'B:/~BUN/root/tsc-kmfg705c.exe'
```

**6. `tsgo` is a `noembed` build and validates its own lib directory at startup.** With
the exe extracted but the libs left embedded, the binary panics before the virtual FS can
serve anything:

```
panic: bundled: C:/Users/Khmil/AppData/Local/Temp/termcraft-tsc-7.0.2/lib.d.ts does not exist; this executable may be misplaced [recovered, repanicked]

goroutine 1 [running]:
github.com/microsoft/typescript-go/internal/bundled.init.func4()
	github.com/microsoft/typescript-go/internal/bundled/noembed.go:40 +0x119
github.com/microsoft/typescript-go/internal/bundled.LibPath(...)
	github.com/microsoft/typescript-go/internal/bundled/bundled.go:31
main.runAPI({0x29388d8a020, 0x5, 0x6})
	github.com/microsoft/typescript-go/cmd/tsgo/api.go:28 +0x1e5
main.runMain()
	github.com/microsoft/typescript-go/cmd/tsgo/main.go:25 +0xc6
main.main()
	github.com/microsoft/typescript-go/cmd/tsgo/main.go:14 +0x13
```

The `noembed` name implies an `embed` build variant exists upstream where the libs *are*
compiled into the Go binary — but that is not what npm ships. *Corrected to:* extract the
lib files to disk next to the extracted exe.

**7. `fileChanges` cannot carry file content** (it is `{changed,created,deleted}` — a
change summary only), so a synthesized tsconfig cannot be injected that way. *Corrected
to:* serve it from the virtual FS.

## The working host code, in full

`src/main.ts`:

```ts
import { API } from "typescript/unstable/sync"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { embeddedLibs } from "./libs.generated.ts"
import tscExePath from "../node_modules/@typescript/typescript-win32-x64/lib/tsc.exe" with { type: "file" }
import runtimeDtsPath from "./runtime.d.ts" with { type: "file" }

const TS_VERSION = "7.0.2"

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

const { exe } = materializeCompiler()

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

const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] })
const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0]
const diags = [
  ...project.program.getConfigFileParsingDiagnostics(),
  ...project.program.getProgramDiagnostics(),
  ...project.program.getSyntacticDiagnostics(),
  ...project.program.getSemanticDiagnostics(),
]

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

api.close()
```

`src/libs.generated.ts` is machine-generated by `src/gen-libs.ts` and is 88 imports of:

```ts
import lib_es5 from "../node_modules/@typescript/typescript-win32-x64/lib/lib.es5.d.ts" with { type: "file" }
// ... 87 more
export const embeddedLibs: Record<string, string> = { "lib.es5.d.ts": lib_es5, /* ... */ }
```

## Concerns

1. **`typescript@7` is a different product than the plan assumed, and the spec should say
   which one it wants.** `bun add typescript` today silently gets the Go port. If the
   product pins `typescript@5`, every finding above is void and the original
   `createProgram` + `CompilerHost` design likely applies (with the lib chain genuinely
   embedded and no subprocess at all). **This is the single biggest decision Task 4
   inherits, and this spike only answers it for 7.x.** A TS5 probe is a small job and
   would de-risk the choice.

2. **The lib import path is platform-specific.** `@typescript/typescript-win32-x64` is
   hardcoded in `libs.generated.ts` and `main.ts`. Bun's file-import attributes are
   static, so a cross-platform build needs per-platform generated imports (or a build
   step per target). Only Windows was in scope here (per Global Constraints) and only
   Windows was proven.

3. **The binary writes 24.5 MB to `%TEMP%` on first run.** Consequences worth a decision:
   the temp dir may be cleaned between runs (re-paying 130 ms), antivirus may inspect or
   quarantine a freshly-written exe (unmeasured, and a real risk on Windows), locked-down
   environments may forbid executing from `%TEMP%`, and `probe.exe` is 124 MB on disk
   because the compiler is embedded *and* then extracted.

4. **The check runs in a child process, so the Gate must handle it crashing.** The
   `noembed` panic above is exactly what a corrupted or half-extracted cache produces. The
   probe does not guard the spawn; product code must, and must treat "compiler died" as
   distinct from "page has type errors" — otherwise a crashed compiler reads as a clean page.

5. **`skipLibCheck: true` and `types: []` were chosen to keep the probe honest and fast**;
   they are not necessarily the right product settings and should be a deliberate choice.

6. **The probe never validated a `page.tsx` that imports anything but `@termcraft/runtime`.**
   Real pages importing relative modules or npm packages will exercise module resolution
   through the virtual FS in ways this spike did not test — and Spike A's finding about
   Bun resolving imports relative to the importing file bears directly on that.

7. **`getAccessibleEntries` is not implemented in the probe's virtual FS.** It fell back to
   the real filesystem 23 times per check without harm here, but a page in a directory with
   unexpected contents could behave differently than in the clean room.

## Files

- `src/main.ts` — the probe (embedded libs + virtual FS + materialized compiler)
- `src/gen-libs.ts` — enumerates the lib chain, generates the imports
- `src/libs.generated.ts` — 88 generated `with { type: "file" }` imports
- `src/baseline.ts` — Step 3 baseline: default host, real FS, `bun run` only
- `src/plan-verbatim.ts` — the plan's Step 3 code, kept to record how it fails
- `src/runtime.d.ts` — the embedded `@termcraft/runtime` facade types
- `fixture/good.tsx`, `fixture/bad.tsx` — the two fixtures
- `bun.lock` — resolved versions

Reproduce: `bun install && bun run src/gen-libs.ts && bun build --compile src/main.ts --outfile probe.exe && ./probe.exe fixture/bad.tsx`

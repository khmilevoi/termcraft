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

Latency: 337 ms

That is one cold check — first-ever run, wall-clock, including a one-time compiler
extraction — as the median of 4 runs spanning 253–503 ms. **The number that actually
matters to a turn is the warm one: ~170 ms** (median of 5; 128–178 ms), because the
extraction happens once per version, not once per check. A Gate that holds the compiler
process open instead pays **~25 ms** for the first check and **~2–4 ms** per retry. All
figures below have verbatim captures behind them.

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
types over the virtual FS. The extraction is the fallback. It is one-time per version and
after it the product is fully self-contained from the user's side — but the binary does
write a 24.5 MB exe to `%TEMP%` on first use, and that is a fact Task 4 must weigh, not a
detail.

### The plan's premise did not survive contact

The plan is built on `ts.createProgram` + a custom `CompilerHost` serving lib files.
**None of those three things exist in the resolved version.** `bun add typescript`
resolves to **7.0.2**, the native Go port. See "Where the plan did not match reality".

## What the virtual FS is actually for

This distinction matters more than it looks, because Task 4 will build from it.

| | Required? |
|---|---|
| Libs must be **embedded** in the binary | **Yes** — nothing else puts them on the user's disk |
| Libs must be **extracted** next to the exe | **Yes** — the Go startup check stats `lib.d.ts` before any VFS exists |
| Libs must be **served over the virtual FS** | **No** — redundant; the Go process reads them off disk itself |
| tsconfig + runtime `.d.ts` served over the VFS | **Yes** — this is the *only* essential job of the VFS |

The VFS's essential role is narrow: the synthesized `tsconfig` and the runtime `.d.ts`.
Neither exists on disk and neither may ever be written there — that is precisely the
spec's *"the project folder never grows a `package.json`"* promise, and the VFS is what
keeps it. An earlier iteration of this probe also served the 88 libs through the VFS on
the theory that the temp dir had no libs next to the exe; that was false —
`materializeCompiler()` writes all 88 there itself, because it must.

Proven, not asserted — identical diagnostics either way:

```
$ ./probe.exe pages/foo/good.tsx              # libs from disk (default)
[]
$ ./probe.exe pages/foo/good.tsx --vfs-libs   # libs served over the VFS
[]
$ ./probe.exe pages/foo/bad.tsx --vfs-libs
[ { "code": 2322, "message": "Type 'number' is not assignable to type 'string'.", "related": [ "The expected type comes from property 'title' which is declared here on type '{ id: string; title: string; }'" ] } ]
```

**The redundant path does not cost RPC round-trips, and removing it did not speed
anything up.** Once an `fs` is registered the Go server routes its FS access through it
regardless; returning `undefined` merely means "fall back to the real disk". So the
callback count is identical and only the payload differs — 621 KB of lib content
marshalled over RPC versus `undefined`:

```
$ ./probe.exe pages/foo/good.tsx --trace-fs
{"fsCallbackHits":{"readFile":90,"fileExists":28}}

$ ./probe.exe pages/foo/good.tsx --vfs-libs --trace-fs
{"fsCallbackHits":{"readFile":90,"fileExists":26,"readFile:lib":87}}
```

`readFile` fires 90 times either way; `readFile:lib` shows 87 of those were libs the VFS
answered with content. The measured cost is within noise:

```
$ for i in 1 2 3; do ./probe.exe pages/foo/good.tsx --timed; done             # default
{"totalMs":60.4,"compilerExtractMs":3.2,"checkMs":57.3,"extractedThisRun":false,"serveLibsOverVfs":false,"embeddedLibCount":88}
{"totalMs":56,"compilerExtractMs":3.8,"checkMs":52.2,"extractedThisRun":false,"serveLibsOverVfs":false,"embeddedLibCount":88}
{"totalMs":61.9,"compilerExtractMs":3.2,"checkMs":58.7,"extractedThisRun":false,"serveLibsOverVfs":false,"embeddedLibCount":88}

$ for i in 1 2 3; do ./probe.exe pages/foo/good.tsx --vfs-libs --timed; done  # redundant path
{"totalMs":56.7,"compilerExtractMs":3.5,"checkMs":53.3,"extractedThisRun":false,"serveLibsOverVfs":true,"embeddedLibCount":88}
{"totalMs":56.7,"compilerExtractMs":3.6,"checkMs":53.1,"extractedThisRun":false,"serveLibsOverVfs":true,"embeddedLibCount":88}
{"totalMs":59.2,"compilerExtractMs":3.2,"checkMs":56,"extractedThisRun":false,"serveLibsOverVfs":true,"embeddedLibCount":88}
```

Task 4 should serve only the tsconfig and the runtime types, and let the libs come off
disk — for simplicity, not for speed.

## The diagnostic union must include `getGlobalDiagnostics()`

This is the most consequential correction in this document, and it is not theoretical.

`getPreEmitDiagnostics` — the API the plan reaches for — includes **global** diagnostics.
An earlier version of this probe unioned config + program + syntactic + semantic and
omitted `getGlobalDiagnostics()` (`dist/api/sync/api.d.ts:198-201`, "global
(non-file-specific) semantic diagnostics", distinct from `getProgramDiagnostics()`'s
options diagnostics). **Missing-lib errors land there and nowhere else** — which is to
say, in exactly the failure mode this spike exists to detect.

Hiding `lib.es5.d.ts` from the compiler (`--break-lib` makes the VFS return `null` =
"does not exist, do not fall back"), with each diagnostic labelled by its bucket:

```
$ ./probe.exe pages/foo/good.tsx --break-lib lib.es5.d.ts --buckets
[
  { "code": 2318, "message": "Cannot find global type 'Boolean'.",          "bucket": "global" },
  { "code": 2318, "message": "Cannot find global type 'CallableFunction'.", "bucket": "global" },
  { "code": 2318, "message": "Cannot find global type 'NewableFunction'.",  "bucket": "global" },
  { "code": 2318, "message": "Cannot find global type 'Object'.",           "bucket": "global" }
]
```

All four are in the `global` bucket. Zero are anywhere else:

```
$ ./probe.exe pages/foo/good.tsx --break-lib lib.es5.d.ts --buckets | grep -c '"bucket": "global"'
4
$ ./probe.exe pages/foo/good.tsx --break-lib lib.es5.d.ts --buckets | grep '"bucket"' | grep -v global | wc -l
0
```

So the pre-fix union returned **`[]` — a clean bill of health — for a program with no
`Object`, `Boolean` or `Function` type at all.** A Gate built on that union would silently
pass pages TypeScript proper rejects. Fixed in `src/main.ts` and `src/baseline.ts`; the
verdict is unaffected because the `libcheck.tsx` control below independently proves the
libs do load.

**Known wrinkle for Task 4:** the union can double-report. A missing file surfaces in two
buckets at once, so the Gate should dedupe on `(code, fileName, pos)`:

```
$ ./probe.exe pages/foo/DOES_NOT_EXIST.tsx --buckets
    "code": 6053,   "bucket": "program"
    "code": 6053,   "bucket": "global"
```

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
 [506ms] compile  probe.exe

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
the binary was copied to a directory containing nothing but itself and the `.tsx` files,
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

Note the probe has no `try`/`catch` around the spawn or the check, so a compiler failure
propagates as a non-zero exit rather than a printed `[]`. The `[]` above is trustworthy.

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

### A broken lib link is silent unless the page uses that lib

Worth knowing, because it bounds what the fixtures can prove. Breaking a lib only
produces an error if something references the types it declares:

```
$ ./probe.exe pages/foo/iter.tsx --break-lib lib.es2015.collection.d.ts --buckets
[
  {
    "code": 2585,
    "message": "'Map' only refers to a type, but is being used as a value here. Do you need to change your target library? Try changing the 'lib' compiler option to es2015 or later.",
    "bucket": "semantic"
  }
]

$ ./probe.exe pages/foo/iter.tsx --break-lib lib.es2015.iterable.d.ts --buckets
[]
```

(`iter.tsx` is `export const m: Map<string, number> = new Map()`.) Removing the lib that
*declares* `Map` is caught; removing `iterable`, whose augmentations `new Map()` never
touches, is not. `lib.es5.d.ts` is the exception that always errors, because its types are
global intrinsics.

**Consequence: no fixture can prove the lib chain is complete.** A page only exercises the
libs it happens to use. The 87-walked == 87-asked cross-check below is therefore the real
evidence for completeness, not the fixtures.

## Latency — half the finding

Every figure below is one process reporting both its own wall-clock and its own
`--timed` breakdown, so the two are directly comparable. Wall-clock is measured with
`[Diagnostics.Stopwatch]` around that same invocation; `performance.now()` starts inside
the process and cannot see the binary's own startup, so `wall − totalMs` is the startup
overhead.

**Cold** — the extraction cache (`%TEMP%\termcraft-tsc-7.0.2`) is deleted before each run:

```powershell
foreach ($i in 1..3) {
  # (the extraction cache directory is deleted here)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & ./probe.exe pages/foo/good.tsx --timed 2>&1
  $sw.Stop()
  ...
}
```

```
wall-clock ms : 253.2
--timed       : {"totalMs":173.9,"compilerExtractMs":59.8,"checkMs":114.1,"extractedThisRun":true,"serveLibsOverVfs":false,"embeddedLibCount":88}
diagnostics   : []

cold 1 : wall=502.5 ms | startup=254.2 ms | {"totalMs":248.3,"compilerExtractMs":80.2,"checkMs":168,"extractedThisRun":true,...}
cold 2 : wall=350.1 ms | startup=115.7 ms | {"totalMs":234.4,"compilerExtractMs":83.5,"checkMs":150.9,"extractedThisRun":true,...}
cold 3 : wall=324.1 ms | startup=107.6 ms | {"totalMs":216.5,"compilerExtractMs":74.8,"checkMs":141.7,"extractedThisRun":true,...}
```

Four cold runs: **253.2 / 324.1 / 350.1 / 502.5 ms**, median **337 ms**. The spread is
wide and the environment was not quiet — two sibling spikes were rebuilding against the
same disk — so treat 337 ms as an order of magnitude, not a constant.

**Warm** — cache intact, five processes:

```
warm 1 : wall=170.4 ms | {"totalMs":65.7,"compilerExtractMs":4.5,"checkMs":61.2,"extractedThisRun":false,...}
warm 2 : wall=137.4 ms | {"totalMs":50.8,"compilerExtractMs":3.5,"checkMs":47.3,"extractedThisRun":false,...}
warm 3 : wall=128.4 ms | {"totalMs":56.4,"compilerExtractMs":3.9,"checkMs":52.5,"extractedThisRun":false,...}
warm 4 : wall=174.2 ms | {"totalMs":76.8,"compilerExtractMs":5.4,"checkMs":71.3,"extractedThisRun":false,...}
warm 5 : wall=177.9 ms | {"totalMs":67.6,"compilerExtractMs":8,"checkMs":59.6,"extractedThisRun":false,...}

warm wall-clock median ms : 170.4
warm wall-clock min/max   : 128.4 / 177.9
```

An earlier, quieter sample of the same build gave 136.5 / 126.8 / 125.1 ms — so ~130 ms
is achievable and ~170 ms is what contention looks like.

Startup overhead is **79–254 ms cold** and **72–110 ms warm** — overlapping, as it should
be. (A previous revision of this document reported cold startup as *lower* than warm,
which is impossible; that artifact came from subtracting a `--timed` figure from a
*different process's* wall-clock. Both numbers now come from the same process.)

**Antivirus is partially measured, not merely suspected.** Cold `checkMs` is 114–168 ms
against a warm ~47–71 ms — a ~2–3× penalty on the first execution of a freshly written
24.5 MB exe, which is what a Defender first-run scan looks like. It decays immediately.

### What it composes to across a turn

The Gate runs on every attempt and §9 allows up to 3 retries, so the user waits for this
up to **four times per turn**:

- **One binary invocation per attempt (as probed): 4 × ~170 ms ≈ 680 ms per turn**
  (≈520 ms on a quiet machine). Plus ~170 ms once, ever, for the first extraction.
- **Holding the compiler open across attempts: ≈ 35 ms per turn.** The TS7 API is a
  long-lived server, so the Gate can keep one `API` instance alive.

Either way this is a `YES` at well under a second per turn, not a `YES` at 8 seconds, and
there is a ~20× headroom option in hand if the Gate ever needs it. Latency is not a risk
for this design.

### Retry cost, measured on a file that actually changes

A re-check of unchanged content proves nothing — it can be served from cache. So
`--retry-sim` **mutates the page between laps** (flipping `Panel({... title: "fine" })`
to `title: 42`) and reports the diagnostic count per lap. If the count does not flip, the
re-check did not happen:

```
$ ./probe.exe pages/foo/good.tsx --retry-sim 6
{"retrySimLaps":[{"ms":27.5,"diags":0},{"ms":18.1,"diags":1},{"ms":2.5,"diags":0},{"ms":3.5,"diags":1},{"ms":2.4,"diags":0},{"ms":3.7,"diags":1}]}

$ ./probe.exe pages/foo/good.tsx --retry-sim 6
{"retrySimLaps":[{"ms":25.4,"diags":0},{"ms":2.5,"diags":1},{"ms":2.3,"diags":0},{"ms":2.1,"diags":1},{"ms":1.9,"diags":0},{"ms":2.1,"diags":1}]}
```

The counts flip `0,1,0,1,0,1` in lockstep with the mutation, so each lap is a real
re-check: **~25 ms for the first check, ~2–4 ms per retry** against a held-open API.

This supersedes an earlier figure of "~11 ms per retry" in a previous revision of this
document, which was measured with `fileChanges: { invalidateAll: true }` on a file that
was never edited. That number was not wrong so much as measuring something else —
`invalidateAll` discards every cache including the parsed libs, making it a pessimistic
upper bound, while `changed: [file]` is what a Gate retry actually does.

The first draft of this control had a bug worth recording: it mutated the first
`title: "..."` in the file, which is `meta = { title: "Good page" }` — an untyped object
literal where a number is perfectly legal. Every lap reported `diags: 0` and the laps
looked plausibly fast. Only the flip assertion caught it.

## The embedded lib file list — 88 files

**How it was determined.** Not by guessing: `lib.esnext.d.ts` is the root of a chain of
`/// <reference lib="..." />` directives, and a missing link surfaces as a confusing
`cannot find name X` rather than an honest "file not found". `src/gen-libs.ts` walks
those directives transitively over the *installed* platform package and emits one Bun
file-import per file (`src/libs.generated.ts`).

**Cross-checked against runtime.** Instrumenting the virtual FS showed the Go compiler
asking for exactly **87** `lib.*.d.ts` files — the same 87 the static walk produced. As
established above, no fixture can prove the chain complete, so this cross-check is the
evidence. The 88th is `lib.d.ts`, which the chain does *not* reference; it is the startup
sentinel the Go binary stats to decide whether it has been misplaced.

**Why `lib: ["esnext"]` is pinned.** The default lib for `target: esnext` is
`lib.esnext.full.d.ts`, which pulls in `lib.dom.d.ts` (2.3 MB),
`lib.webworker.importscripts.d.ts` and `lib.scripthost.d.ts`. Pinning to `["esnext"]`
keeps the chain at the 87 files above and keeps ~3.1 MB of browser typings out of the
binary — and out of a TUI's global scope, where `document` should not exist. (`lib.d.ts`
itself is *not* the esnext default; it is the ES5 one, and it is embedded here purely as
the startup sentinel. Its own chain — es5/dom/webworker/scripthost — is deliberately not
followed.)

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
the probe unions config-parsing + program + syntactic + semantic + **global** diagnostics
(see above — the global bucket is not optional).

**2. The lib `.d.ts` files are not where the plan points.** The plan imports
`../node_modules/typescript/lib/lib.esnext.d.ts`. That path **does not exist** — TS7's
`node_modules/typescript/lib/` holds five files (`getExePath.js`, `getExePath.d.ts`,
`tsc.js`, `version.cjs`, `version.d.cts`) and no `lib.*.d.ts` at all.
*Corrected to:* `../node_modules/@typescript/typescript-win32-x64/lib/lib.esnext.d.ts` —
the libs ship in the per-platform package, next to `tsc.exe`. **This makes the import
path OS/arch-dependent**, which the plan's design did not anticipate.

**3. There is no `CompilerHost`, so `getSourceFile`/`fileExists`/`readFile` cannot be
overridden.** *Corrected to:* the TS7 analogue, `new API({ fs })` — a virtual filesystem
the Go server delegates back to over RPC (`readFile`, `fileExists`, `directoryExists`,
`getAccessibleEntries`, `realpath`). Its essential role is narrower than the plan implies:
see "What the virtual FS is actually for".

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

`src/main.ts`, verbatim and complete:

```ts
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
 * Cached by version + exe size + presence of the last lib written, so a half-cleaned
 * temp dir re-extracts instead of reproducing the noembed panic.
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
    // target:esnext is lib.esnext.full.d.ts, which drags in lib.dom.d.ts (2.3 MB)
    // and lib.webworker.d.ts (0.8 MB) — neither embedded, and neither wanted in a TUI.
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
    if (brokenLib && path.basename(fileName) === brokenLib) return null
    if (fileName === tsconfigPath) return tsconfig
    if (fileName === runtimeDts) return readEmbedded(runtimeDtsPath)
    if (SERVE_LIBS_OVER_VFS) {
      const base = path.basename(fileName)
      if (embeddedLibs[base]) {
        bump("readFile:lib")
        return readEmbedded(embeddedLibs[base]!)
      }
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

if (has("--trace-fs")) console.error(JSON.stringify({ fsCallbackHits: fsHits }))

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
   the temp dir may be cleaned between runs (re-paying ~170 ms), locked-down environments
   may forbid executing from `%TEMP%`, and `probe.exe` is 124 MB on disk because the
   compiler is embedded *and* then extracted. Antivirus is no longer merely suspected: the
   cold-vs-warm `checkMs` gap (114–168 ms vs 47–71 ms) is a ~2–3× first-execution penalty
   consistent with a Defender scan of the freshly written exe. It decays after one run.

4. **The check runs in a child process, so the Gate must handle it crashing.** The
   `noembed` panic above is exactly what a corrupted or half-extracted cache produces. This
   probe deliberately has no `try`/`catch` — a spawn failure exits non-zero rather than
   printing `[]` — but product code must treat "compiler died" as distinct from "page has
   type errors". A crashed compiler that reads as a clean page is a hole in the very wall
   the Gate exists to be.

5. **The extraction cache is validated by existence, not integrity.** `materializeCompiler()`
   checks the exe's size and that all 88 libs exist; it does not hash them. A truncated or
   tampered lib would be reused silently. Adequate for a probe; Task 4 should decide
   whether a content hash is warranted.

6. **`skipLibCheck: true` and `types: []` were chosen to keep the probe honest and fast**;
   they are not necessarily the right product settings and should be a deliberate choice.

7. **The probe never validated a `page.tsx` that imports anything but `@termcraft/runtime`.**
   Real pages importing relative modules or npm packages will exercise module resolution
   through the virtual FS in ways this spike did not test — and Spike A's finding about
   Bun resolving imports relative to the importing file bears directly on that.

8. **`directoryExists` and `getAccessibleEntries` are not implemented in the probe's
   virtual FS.** Both fall through to the real filesystem (`directoryExists` fired 23
   times per check in an earlier trace; `getAccessibleEntries` did not fire at all for
   these fixtures). Harmless here, but a page in a directory with unexpected contents, or
   a project layout that makes the compiler enumerate directories, could behave
   differently than in the clean room.

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


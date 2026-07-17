# Spike A — dynamic TSX import with embedded-module resolution

## The question

Can a `bun build --compile` binary, at runtime on Windows, dynamically import an
arbitrary external `.tsx` file from disk, and have *that file's*
`import { … } from '@termcraft/runtime'` resolve to a module embedded in the binary —
with no `node_modules` and no `package.json` anywhere near the `.tsx` file?

Verdict: YES-WITH-FALLBACK: a

Fallback **(a), a `Bun.plugin` runtime resolver registered inside the compiled binary,
works** — and it is the only one of the four that does not relocate the page, which turns
out to be decisive. But **(a) requires two module registrations, not one**: the runtime
*and* the JSX helper the transform generates. See "JSX" below — a first revision of this
document tested no JSX at all and consequently claimed more than it had measured.

One spec claim does die. See "Which spec claims die" at the end.

## Environment

- Windows 11, `Microsoft Windows [Version 10.0.26200.8875]`
- `bun 1.3.14` (matches the version the plan recorded on 2026-07-17)
- This spike installs no dependencies, so it has **no `bun.lock`** (per Constraint 5,
  saying so explicitly). The only version that matters here is `bun` itself.
- **Each `bun build --compile` binary is 94 MB.** Recorded here because it is a cost input
  Task 4 needs and it is a fact this spike measured.

## Naive: bare specifier

```bash
cd docs/spikes/01-tsx-import
bun build --compile src/main.ts --outfile probe.exe
./probe.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
```

Build output:

```
  [11ms]  bundle  1 modules
 [431ms] compile  probe.exe
```

Probe output, verbatim (exit code 1):

```
{"ok":false,"specifier":"file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page.tsx","name":"ResolveMessage","message":"Cannot find module '@termcraft/runtime' from 'C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page.tsx'"}
```

**The naive path fails.** This confirms Known Risk 1 from the plan: Bun resolved
`@termcraft/runtime` relative to the *importing file's* own directory
(`fixture\page.tsx`), not against the modules embedded in the binary, and there is no
`node_modules` in that tree.

### Control: is the failure an artifact of the fixture's location?

`docs/spikes/01-tsx-import/` contains a `package.json` (with no dependencies), so the
fixture technically has a `package.json` ancestor; the real scenario (`.termcraft/pages/foo/`)
has none. Re-run against an identical page in a temp directory with **no `package.json` and
no `node_modules` ancestor whatsoever**:

```bash
./probe.exe "C:\Users\Khmil\AppData\Local\Temp\tc-naive2-zEthFQ\page.tsx"
```

```
{"ok":false,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-naive2-zEthFQ/page.tsx","name":"ResolveMessage","message":"Cannot find module '@termcraft/runtime' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-naive2-zEthFQ\\page.tsx'"}
```

Identical failure. Bun does **not** fall back to the binary's embedded modules when the
importing file has no package tree of its own. The naive failure is universal.

### The most useful detail in the failure

The error is a `ResolveMessage` naming the bare specifier — **not** a syntax, parse, or
loader error about the `.tsx` file. Bun found, read, and parsed an external TSX file from an
arbitrary disk location inside a compiled binary without complaint. Only the bare specifier
is unresolved. The real question was never "can the binary import external TSX" (it can,
natively); it was only "can a bare specifier be pointed at an embedded module".

## Fallback (a): Bun runtime plugin with a custom resolver — **WORKS**

Entry: `src/main-a.ts`. Registers the plugin before the dynamic import; the page is imported
**at its original path**, untouched.

```ts
import { plugin } from "bun"
import * as runtime from "./runtime.ts"

plugin({
  name: "termcraft-runtime-resolver",
  setup(build) {
    build.module("@termcraft/runtime", () => ({
      exports: runtime,
      loader: "object",
    }))
  },
})
```

```bash
bun build --compile src/main-a.ts --outfile probe-a.exe
./probe-a.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
```

Verbatim (exit code 0):

```
{"ok":true,"specifier":"file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page.tsx","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

**`Bun.plugin` IS honored inside a compiled binary at runtime.** That was the open question,
and the answer is yes.

Verified, not a stub, on two independent counts:
- `rendered` is exactly `Panel#root(hello from an external file)`. That string exists whole in
  no source file; it can only be produced by the real `Panel` from the embedded `runtime.ts`,
  called with the external page's own props.
- `meta.kitApiVersion` is `1`, obtainable only by importing `kitApiVersion` from the embedded
  module.

**This is necessary but not sufficient for a real page.** The fixture above calls
`Panel({...})` as a plain function. A real page is JSX, and JSX needs a second registration —
see below.

## Fallback (b): transpile-then-import — **WORKS ONLY AFTER CORRECTION**

### (b) as the plan literally wrote it — fails

```bash
bun build --compile src/main-b-literal.ts --outfile probe-b-literal.exe
./probe-b-literal.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
```

Verbatim (exit 1):

```
{"ok":false,"name":"Error","message":"ENOENT: no such file or directory, copyfile '\\B:\\%7EBUN\\root\\runtime.ts'"}
```

This single error confirms **both** traps the plan and constraints flagged:
1. Inside a compiled binary, `import.meta.url` points into Bun's **virtual filesystem**
   (`B:\~BUN\root\`), which does not exist on real disk — so `cpSync` cannot read it.
2. `.pathname` mangled the path: `~` percent-encoded to `%7E`, plus a leading `\`. This is
   the `new URL(...).pathname` trap from Constraint 7.

### (b) corrected — works

Entry: `src/main-b.ts`. The runtime is embedded as an asset (`with { type: "file" }`, which
the plan predicted would be needed) and materialized with `Bun.file(...).text()` +
`writeFileSync` instead of `cpSync`.

```bash
bun build --compile src/main-b.ts --outfile probe-b.exe
./probe-b.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
./probe-b.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page-with-sibling.tsx"
```

Plain page, verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-probe-5A9CKz","runtimeAsset":"B:/~BUN/root/runtime-nge5eq4c.ts","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Note `runtimeAsset: "B:/~BUN/root/runtime-nge5eq4c.ts"` — direct confirmation of the VFS
diagnosis. `with { type: "file" }` yields a VFS path that `Bun.file()` reads fine; only
real-disk APIs like `cpSync` reject it.

Sibling fixture, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-probe-cmX3e7\\page.mjs'"}
```

## Fallback (c): scratch-directory shim — **WORKS FOR PLAIN PAGES, BREAKS ON SIBLINGS**

Entry: `src/main-c.ts`. Correction: the plan's snippet reads
`await Bun.file(runtimeSourcePath).text()` but **never defines `runtimeSourcePath`**;
substituted the embedded asset.

```bash
bun build --compile src/main-c.ts --outfile probe-c.exe
./probe-c.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
./probe-c.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page-with-sibling.tsx"
```

Plain page, verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-shim-zpbxvK","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Sibling fixture, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-shim-mzNOjf\\page.tsx'"}
```

The plan explicitly asked whether this survives a page importing a sibling by relative path.
**It does not.** Copying the page alone into a scratch dir severs it from its neighbours.
Surviving would mean copying the whole page directory tree — and deciding how far that tree
extends, an unbounded question on a user's disk.

## Fallback (d): specifier rewrite without transpiling — **WORKS FOR PLAIN PAGES, BREAKS ON SIBLINGS**

Entry: `src/main-d.ts`. Correction: the plan's snippet uses `scratch` and `runtimeAbsPath`
without defining either; both supplied.

```bash
bun build --compile src/main-d.ts --outfile probe-d.exe
./probe-d.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page.tsx"
./probe-d.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page-with-sibling.tsx"
```

Plain page, verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-rewrite-vAiOoh","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Sibling fixture, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-rewrite-llBVr7\\page.tsx'"}
```

(d) confirms the naive error's implication — Bun imports external TSX natively, so no
transpile step is required. But because it must write the rewritten file *somewhere*, it
inherits the same relocation problem as (b) and (c).

## The sibling-import matrix — the finding that separates the four

`fixture/page-with-sibling.tsx` imports both `@termcraft/runtime` (bare) and `./sibling.ts`
(relative). Real design pages plausibly do this.

| Fallback | Plain page | Page with relative sibling import | Relocates the page? |
|---|---|---|---|
| (a) `Bun.plugin` resolver | works | **works** | **no** |
| (b) transpile-then-import | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |
| (c) scratch-dir shim | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |
| (d) specifier rewrite | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |

```bash
./probe-a.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page-with-sibling.tsx"
```

Fallback (a) with the sibling fixture, verbatim (exit 0):

```
{"ok":true,"specifier":"file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page-with-sibling.tsx","meta":{"title":"Probe page with sibling","kitApiVersion":1},"rendered":"Panel#root(hello + sibling-ok)"}
```

(b), (c) and (d) all fail for the same structural reason: they solve the bare specifier by
moving the page to a directory the binary controls, which breaks every *other* relative path
the page depends on. (a) solves the bare specifier without moving anything. This is a
capability difference, not a cost tiebreaker.

## JSX — the page format the spec actually mandates

The spec requires (`docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md:679-680`):

> Prove compiler-owned JSX support works while explicit `react/jsx-runtime` and runtime
> subpath imports fail.

with `:92` ("compiler owns the JSX transform and resolves any generated JSX helper
internally") and `:47`/`:162` forbidding a page from importing `react/jsx-runtime` explicitly.

Every fixture above calls `Panel({...})` as a plain function — **no JSX anywhere**, despite
`.tsx` extensions. A real page is JSX whose helper import is *generated by the transform*, not
written by the author, and that generated bare specifier faces exactly the failure class the
naive probe caught. Both halves of the spec's requirement were therefore tested.

Entry: `src/main-jsx.ts`, with three modes — `bare` (only `@termcraft/runtime`, i.e. what
fallback (a) originally registered), `with-jsx` (also `react/jsx-runtime` *and*
`react/jsx-dev-runtime`), and `dev-only` (only `react/jsx-dev-runtime`).
Fixtures: `fixture/page-jsx.tsx` (real JSX, no explicit helper import),
`fixture/page-jsx-explicit.tsx` (imports `react/jsx-runtime` directly),
`fixture/page-jsx-explicit-dev.tsx` (imports `react/jsx-dev-runtime` directly).

```bash
bun build --compile src/main-jsx.ts --outfile probe-jsx.exe
./probe-jsx.exe "…\fixture\page-jsx.tsx" bare
./probe-jsx.exe "…\fixture\page-jsx.tsx" with-jsx
./probe-jsx.exe "…\fixture\page-jsx-explicit.tsx" with-jsx
./probe-jsx.exe "…\fixture\page-jsx.tsx" dev-only
./probe-jsx.exe "…\fixture\page-jsx-explicit.tsx" dev-only
./probe-jsx.exe "…\fixture\page-jsx-explicit-dev.tsx" dev-only
NODE_ENV=production ./probe-jsx.exe "…\fixture\page-jsx.tsx" dev-only
NODE_ENV=production ./probe-jsx.exe "…\fixture\page-jsx.tsx" with-jsx
NODE_ENV=production ./probe-jsx.exe "…\fixture\page-jsx-explicit.tsx" with-jsx
```

### 1. A real JSX page FAILS under fallback (a) as originally tested (exit 1)

```
{"ok":false,"mode":"bare","helpersCalled":[],"name":"ResolveMessage","message":"Cannot find module 'react/jsx-dev-runtime' from 'C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-jsx.tsx'"}
```

Registering `@termcraft/runtime` alone is **not enough**. Note the specifier: the transform
generates **`react/jsx-dev-runtime`**, not `react/jsx-runtime`.

### 2. Compiler-owned JSX WORKS once the helper is registered (exit 0)

```
{"ok":true,"mode":"with-jsx","helpersCalled":["jsxDEV"],"meta":{"title":"JSX probe","kitApiVersion":1},"rendered":"Panel#root(hello from JSX)"}
```

The transform calls **`jsxDEV`**. `rendered` is a real render through the embedded `Panel`.
So the spec's first half holds: compiler-owned JSX support works, via a second
`build.module` — the same mechanism as (a), just applied twice.

### 3. Explicit `react/jsx-runtime` SUCCEEDS under `with-jsx` — the spec requires it to FAIL (exit 0)

```
{"ok":true,"mode":"with-jsx","helpersCalled":["jsx"],"meta":{"title":"explicit jsx-runtime import","kitApiVersion":1},"rendered":"Panel#root(hello from explicit jsx-runtime)"}
```

### 4. `dev-only` satisfies BOTH halves — in dev mode

Because the transform emits `react/jsx-dev-runtime` while an author writes
`react/jsx-runtime`, registering only the former separates them:

```
{"ok":true,"mode":"dev-only","helpersCalled":["jsxDEV"],"meta":{"title":"JSX probe","kitApiVersion":1},"rendered":"Panel#root(hello from JSX)"}
{"ok":false,"mode":"dev-only","helpersCalled":[],"name":"ResolveMessage","message":"Cannot find module 'react/jsx-runtime' from 'C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-jsx-explicit.tsx'"}
```

Compiler-owned JSX works; explicit `react/jsx-runtime` fails. Both spec halves satisfied.
**But this rests on two things that are not contracts.**

### 5. `NODE_ENV=production` collapses the distinction (exit 1, then 0, then 0)

```
NODE_ENV=production, dev-only, page-jsx.tsx:
{"ok":false,"mode":"dev-only","helpersCalled":[],"name":"ResolveMessage","message":"Cannot find module 'react/jsx-runtime' from 'C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-jsx.tsx'"}

NODE_ENV=production, with-jsx, page-jsx.tsx:
{"ok":true,"mode":"with-jsx","helpersCalled":["jsx"],"meta":{"title":"JSX probe","kitApiVersion":1},"rendered":"Panel#root(hello from JSX)"}

NODE_ENV=production, with-jsx, page-jsx-explicit.tsx:
{"ok":true,"mode":"with-jsx","helpersCalled":["jsx"],"meta":{"title":"explicit jsx-runtime import","kitApiVersion":1},"rendered":"Panel#root(hello from explicit jsx-runtime)"}
```

`NODE_ENV=production` flips the transform to emit **`react/jsx-runtime`** and call `jsx` —
the exact specifier an author would write. Under production the generated and author-written
imports are **literally the same string arriving at the same resolver hook**, so no resolver
can tell them apart. Registering it (required for JSX to work at all) necessarily makes
explicit imports work too.

### 6. `dev-only` is not a boundary anyway (exit 0)

An author who writes the *dev* subpath explicitly resolves fine:

```
{"ok":true,"mode":"dev-only","helpersCalled":["jsxDEV"],"meta":{"title":"explicit jsx-dev-runtime import","kitApiVersion":1},"rendered":"Panel#root(hello from explicit jsx-DEV-runtime)"}
```

So `dev-only` does not *forbid* explicit helper imports; it only fails the one string authors
happen to type. It is an accident of default transform mode, not an enforced rule.

### JSX matrix

| NODE_ENV | registered | fixture | result |
|---|---|---|---|
| unset/dev | `@termcraft/runtime` only (`bare`) | JSX page | **FAIL** `Cannot find module 'react/jsx-dev-runtime'` |
| unset/dev | `dev-only` | JSX page | OK, `jsxDEV` |
| unset/dev | `dev-only` | explicit `react/jsx-runtime` | **FAIL** (spec's wish) |
| unset/dev | `dev-only` | explicit `react/jsx-dev-runtime` | OK — so not a real boundary |
| unset/dev | `with-jsx` | JSX page | OK, `jsxDEV` |
| unset/dev | `with-jsx` | explicit `react/jsx-runtime` | OK — **contradicts spec** |
| production | `dev-only` | JSX page | **FAIL** `Cannot find module 'react/jsx-runtime'` |
| production | `with-jsx` | JSX page | OK, `jsx` |
| production | `with-jsx` | explicit `react/jsx-runtime` | OK — **contradicts spec** |

**Conclusion.** Compiler-owned JSX works, and fallback (a) extends to it cleanly — register
`react/jsx-dev-runtime` (dev) and/or `react/jsx-runtime` (production) alongside
`@termcraft/runtime`. The helper module must export `jsx`, `jsxs`, `jsxDEV` and `Fragment`;
this probe saw `jsxDEV` called in dev and `jsx` in production. But the spec's requirement
that **explicit `react/jsx-runtime` imports fail is not enforceable at the resolver level**.
It appears satisfiable in dev only because Bun's dev transform happens to emit a different
specifier than the one authors type — and `NODE_ENV=production` erases even that. If pages
must be forbidden from importing the helper directly, that has to be enforced by the
**checker/linter on the source text** (Spike C's territory), not by module resolution.

## Step 7 measurements

### 1. `import.meta` / `__dirname` sanity — **fully sane**

```bash
bun build --compile src/main-measure.ts --outfile probe-measure.exe
./probe-measure.exe "C:\Users\Khmil\RustProjects\termcraft\docs\spikes\01-tsx-import\fixture\page-meta.tsx"
```

```json
"importMetaSanity": {
  "importMetaUrl": "file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page-meta.tsx",
  "importMetaDir": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
  "importMetaPath": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-meta.tsx",
  "importMetaDirname": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
  "dirname": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
  "filename": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-meta.tsx"
}
```

All six report the page's **real on-disk location**, not the binary's VFS and not a temp dir.
`__dirname`/`__filename` are defined even though the page is an ES module (a Bun convenience;
do not assume this in Node).

Measured under (a). Under (b)/(c)/(d) these were **not** measured; since those approaches
copy the page into a temp dir, they would be *expected* to report the temp path instead —
that is inference from the relocation, not an observation.

### 2. Module-cache staleness — **stale; query ignored as module key**

```json
"moduleCache": {
  "firstRender": "Panel#root(VERSION-1)",
  "secondRenderSameSpecifier": "Panel#root(VERSION-1)",
  "staleOnReimport": true,
  "bustedRenderWithQuery": "Panel#root(VERSION-1)",
  "cacheBustableViaQuery": false,
  "queryReturnsSameModuleObject": true,
  "mechanism": "(a) query ignored as module key - same module object returned",
  "freshFileNewDirRender": "Panel#root(VERSION-2)",
  "freshFileSeesNewContent": true
}
```

- Re-importing the **same specifier** after changing the file serves the **stale** module.
- The standard Node cache-bust trick `?v=<ts>` **does not work in Bun**.
- **Mechanism isolated** (not inferred): `queryReturnsSameModuleObject: true` — the
  `?v=`-suffixed import returned *the identical module object*. So Bun ignores the query as
  part of the module key; it is not "new module entry, stale bytes".
- **Control**: the same `VERSION-2` bytes at a **new path in a new directory** render
  `VERSION-2` (`freshFileSeesNewContent: true`). There is no content-keyed source cache. The
  staleness is strictly per resolved path.

**A fresh process picks up the change**, verified cross-process:

```bash
./probe-a.exe "<temp>\page.tsx"     # then edit the file, then run again
```

```
--- process 1 (EDIT-1) ---
{"ok":true,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-respawn-LAuugh/page.tsx","rendered":"Panel#root(EDIT-1)"}
--- process 2, same path, file changed on disk ---
{"ok":true,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-respawn-LAuugh/page.tsx","rendered":"Panel#root(EDIT-2)"}
```

So §4.2's respawn-per-source is not merely survivable — it is the **only** found way to
re-read a changed page. In-process hot reload is unavailable by any means found here.

### 3. Wall-clock — **spawn dominates the import by ~50x**

The headline number is **spawn → first render**, because respawn-per-source is the only way
to re-render a changed page, so that is what one preview actually costs.

```bash
bun build --compile src/main-cold.ts --outfile probe-cold.exe
bun src/spawn-bench.ts ./probe-cold.exe "…\fixture\page.tsx" 10
bun src/spawn-bench.ts ./probe-cold.exe "…\fixture\page-jsx.tsx" 10
```

`src/main-cold.ts` imports exactly ONE page and exits, so its number is a genuinely cold
first import. `src/spawn-bench.ts` measures wall clock from the parent across 10 spawns.

Plain page, verbatim:

```json
"spawnToRenderWallClockMs": { "all": [50.1,55.5,50.5,62,51.6,51.2,47.9,53.3,54.1,52],
  "firstRunMs": 50.1, "medianMs": 52, "minMs": 47.9, "maxMs": 62 },
"inProcessFirstImportAndRenderMs": { "all": [1.2,1.1,1.1,1.1,1,0.9,1,0.9,1.2,1],
  "firstRunMs": 1.2, "medianMs": 1.1, "minMs": 0.9, "maxMs": 1.2 },
"lastChildOutput": "{\"ok\":true,\"msBeforeImportStarted\":26.875,\"firstImportAndRenderMs\":1.001,\"totalInProcessMs\":27.875,\"rendered\":\"Panel#root(hello from an external file)\"}"
```

JSX page (the real page format), verbatim:

```json
"spawnToRenderWallClockMs": { "all": [46.9,42.1,44.5,43.8,48.2,41.8,43.9,43.7,41.4,44.1],
  "firstRunMs": 46.9, "medianMs": 43.9, "minMs": 41.4, "maxMs": 48.2 },
"inProcessFirstImportAndRenderMs": { "all": [0.9,1,1,0.9,0.9,1,1,0.9,0.9,0.9],
  "firstRunMs": 0.9, "medianMs": 0.9, "minMs": 0.9, "maxMs": 1 },
"lastChildOutput": "{\"ok\":true,\"msBeforeImportStarted\":23.41,\"firstImportAndRenderMs\":0.924,\"totalInProcessMs\":24.334,\"rendered\":\"Panel#root(hello from JSX)\"}"
```

**One preview costs ~44–52 ms end to end, of which the import + render is ~1 ms.** The rest is
process spawn and Bun runtime init (`msBeforeImportStarted` ≈ 23–27 ms inside the child, plus
OS spawn overhead outside it). Import cost is ~2% of the total; **spawn dominates by roughly
50x**. Optimising the import would be pointless; the only lever that matters is how often you
respawn.

Secondary, same-process number for completeness (`main-measure.ts`, 10 distinct files):
median **0.312 ms**, min 0.16, max 8.969. This is a **warm** figure — that harness imports
several pages before its loop, so the transpiler and JIT are hot. It measures "no module-cache
hit for this file", not a cold process. It is not the preview cost.

Caveat: all fixtures are a few lines long. A real design page with a deep component tree will
transpile more slowly, so ~1 ms is a floor. Given spawn is ~45 ms, a page would have to get
dramatically larger before import cost mattered.

### 4. Bonus finding — Bun caches directory listings

```json
"directoryListingCache": {
  "aRender": "Panel#root(A)",
  "bCreatedAfterDirWasResolved": "FAILED: Cannot find module 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-dircache-5QuRuA\\b.tsx' from 'B/~BUN/root/probe-measure.exe'"
}
```

Import `a.tsx` from a directory, then create `b.tsx` **in that same directory** and import it:
Bun cannot find `b.tsx`. It appears to cache the directory listing at first resolve, so files
created afterwards are invisible to that process. The first draft of the timing harness failed
outright for this reason until every file was written **before** the first import of that
directory.

Combined with finding 2, the rule is: **a process sees the directory as it was when it first
looked, and a given path as it was when it first read it.** Respawn cures both.

## Discrepancies between the plan and reality

Recorded per Constraint 6.

1. **(b) `cpSync(new URL("./runtime.ts", import.meta.url).pathname, …)` fails**, with
   `ENOENT … copyfile '\B:\%7EBUN\root\runtime.ts'`. Two independent bugs: the VFS path is
   not on real disk, and `.pathname` mangles it. Corrected to `with { type: "file" }` +
   `Bun.file(...).text()` + `writeFileSync`. The plan predicted the first half only.
2. **(c) uses `runtimeSourcePath`, never defined** in the snippet. Corrected to the embedded
   asset.
3. **(d) uses `scratch` and `runtimeAbsPath`, neither defined** in the snippet. Both supplied.
4. **The plan's fixtures contain no JSX**, though the spec makes JSX the page format and
   `:679-680` explicitly requires proving JSX behaviour. The brief mandated a JSX-free
   `page.tsx`, so a first revision of this spike tested only plain function calls and claimed
   the premise survived on that basis. JSX fixtures were added and the conclusions corrected.
   **This is the most consequential defect found in the plan.**
5. **Deviation, for auditability:** the brief says to add fallback (a) to `src/main.ts`.
   Instead each fallback got its own entry point, leaving `src/main.ts` as the pristine naive
   probe, so no later fallback can overwrite the naive failure.

Fixtures added beyond the brief's list, each answering a question the brief or spec asks:
`page-with-sibling.tsx` + `sibling.ts` (Step 6c), `page-meta.tsx` (Step 7), and
`page-jsx.tsx` / `page-jsx-explicit.tsx` / `page-jsx-explicit-dev.tsx` (spec :679-680).

## What this means, in plain language

**The core mechanism works.** A compiled `termcraft` binary on Windows can pick up an
arbitrary `.tsx` file from anywhere on disk and run it, with that file's
`import { … } from '@termcraft/runtime'` wired straight to code baked into the binary. The
user's project folder never needs a `package.json` or a `node_modules` — that promise is
keepable, verified against a page in a directory with no package tree anywhere above it.

It does not work by itself. Left alone, Bun looks for the module next to the page and fails
with `Cannot find module`. The fix lives entirely in the host: register a `Bun.plugin`
resolver at startup that serves modules from memory, before importing anything. `Bun.plugin`
being honored inside a compiled binary was the genuine unknown; it is.

**Register two modules, not one.** A real page is JSX, and the JSX transform generates its own
helper import that must also resolve into the host. Registering `@termcraft/runtime` alone
makes a real JSX page fail with `Cannot find module 'react/jsx-dev-runtime'`. Register the JSX
helper too — `react/jsx-dev-runtime` in dev, `react/jsx-runtime` under
`NODE_ENV=production` — exporting `jsx`, `jsxs`, `jsxDEV` and `Fragment`. Registering both
subpaths is the safe default.

Pick **(a)**, and not merely because it is cheapest. The other three work for a toy page and
all break the moment a page imports a file next to it, because they fix the bare specifier by
moving the page somewhere else, which breaks everything else the page points at. (a) moves
nothing, so relative imports and `import.meta` keep working.

**Budget ~45–52 ms per preview, and stop thinking about import cost.** Because a process gets
one look at a page (a changed file re-imported in-process serves the old version, and Bun
ignores the `?v=` trick that works in Node — confirmed to be query-ignored module keying, not
stale bytes), respawn-per-source is the only way to re-render. So one preview = one process
spawn ≈ 45–52 ms, of which the import is ~1 ms. Spawn dominates ~50x. Respawn is now a
correctness requirement, not an implementation detail. Bun also caches directory listings, so
a page created after a directory was first read is invisible to that process — respawn cures
that too.

## Which spec claims die

The verdict is `YES-WITH-FALLBACK: a`, so the central premise — "designs are code", a project
folder with no `package.json`/`node_modules`, pages imported from arbitrary disk locations —
**survives**, including for real JSX pages.

**One spec claim dies:** the requirement at
`docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md:679-680` that explicit
`react/jsx-runtime` and runtime subpath imports **fail**, as a property of module resolution.
They do not. Under `NODE_ENV=production` the transform generates the identical specifier an
author would write, so the resolver provably cannot distinguish them; registering it — which
JSX requires — necessarily makes explicit imports resolve. In dev mode the separation is real
but incidental (`react/jsx-dev-runtime` vs `react/jsx-runtime`) and still not a boundary,
since an author who writes the dev subpath is served happily.

`:92` ("compiler owns the JSX transform and resolves any generated JSX helper internally")
**survives** — the host does own it, via the plugin.

`:47`/`:162` (a page must not import `react/jsx-runtime`) survive **only as a rule to be
enforced elsewhere** — by the checker on source text, which is Spike C's territory. They
cannot be enforced by resolution. Task 4 should move that requirement out of the runtime
layer and into the checker, or drop it.

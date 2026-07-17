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

No spec claims die. But resolution provides **no backstop** under the Gate's source-text import
scan, which matters for Task 4. See "Which spec claims die" at the end.

## Environment

- Windows 11, `Microsoft Windows [Version 10.0.26200.8875]`
- `bun 1.3.14` (matches the version the plan recorded on 2026-07-17)
- This spike installs no dependencies, so it has **no `bun.lock`** (per Constraint 5,
  saying so explicitly). The only version that matters here is `bun` itself.
- **Each `bun build --compile` binary is 94 MB**, measured, not recalled:

  ```bash
  bun build --compile src/main-jsx-multi.ts --outfile probe-jsx-multi.exe
  ls -l probe-jsx-multi.exe | awk '{printf "BINARY SIZE: %d bytes (%.0f MB)\n", $5, $5/1048576}'
  # BINARY SIZE: 98480216 bytes (94 MB)
  ```

  Recorded because it is a cost input Task 4 needs. Note this is a *minimal* probe; the shipped
  host will be larger.

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

### 7. Multi-child JSX, fragments and keys — the paths a single-child fixture never reaches

The tests above all use a single, childless element. That is not a real page: nearly every real
page has an element with more than one child, or a `<>…</>`, or a keyed list. Fixtures
`fixture/page-jsx-multi.tsx` (multiple children, a fragment, a keyed `.map`) and
`fixture/page-jsx-keyed-multi.tsx` (keyed elements that *have* children) force those paths.
Probe `src/main-jsx-multi.ts` records what each helper actually receives.

The obvious hypothesis — that the transform emits `jsx` for one-or-zero children and `jsxs` for
multiple — turns out to be **true only in production**. In dev there is no `jsxs` call at all.
Both modes were therefore measured; the results are below and the mode caveat matters
everywhere `jsxs` is mentioned.

```bash
bun build --compile src/main-jsx-multi.ts --outfile probe-jsx-multi.exe
./probe-jsx-multi.exe "…\fixture\page-jsx-multi.tsx"
NODE_ENV=production ./probe-jsx-multi.exe "…\fixture\page-jsx-multi.tsx"
```

**Dev** (`NODE_ENV` unset) — **excerpt**, not verbatim: 3 of 8 invocations, reformatted, with
the repeated `self` argument elided as `{ "meta": {…} }`. The complete unabridged output of all
8 invocations is in `.superpowers/sdd/task-1-report.md` (round 3).

```json
"helpersCalled": ["jsxDEV","jsxDEV","jsxDEV","jsxDEV","jsxDEV","jsxDEV","jsxDEV","jsxDEV"],
"distinctHelpers": ["jsxDEV"],
{ "helper": "jsxDEV", "type": "Fragment", "propKeys": ["children"], "childrenKind": "array(2)",
  "keyPositional": null, "extraArgs": [true, null, { "meta": {…} }] },
{ "helper": "jsxDEV", "type": "Panel", "propKeys": ["id","title"], "childrenKind": "none",
  "keyPositional": "a", "extraArgs": [false, null, { "meta": {…} }] },
{ "helper": "jsxDEV", "type": "Panel", "propKeys": ["id","title","children"],
  "childrenKind": "array(4)", "keyPositional": null, "extraArgs": [true, null, { "meta": {…} }] }
"rendered": "Panel#root(multi)"
```

**Production** — **excerpt**: 4 of 8 invocations (the `helpersCalled` line above them is
complete). Full output likewise in the round-3 report section.

```json
"helpersCalled": ["jsx","jsx","jsx","jsx","jsxs","jsx","jsx","jsxs"],
"distinctHelpers": ["jsx","jsxs"],
{"helper":"jsxs","type":"Fragment","propKeys":["children"],"childrenKind":"array(2)","keyPositional":null,"extraArgs":[]}
{"helper":"jsx","type":"Panel","propKeys":["id","title"],"childrenKind":"none","keyPositional":"a","extraArgs":[]}
{"helper":"jsx","type":"Panel","propKeys":["id","title"],"childrenKind":"none","keyPositional":"b","extraArgs":[]}
{"helper":"jsxs","type":"Panel","propKeys":["id","title","children"],"childrenKind":"array(4)","keyPositional":null,"extraArgs":[]}
```

### `jsxs` with a key — the one slot that was extrapolated, now observed

In `page-jsx-multi.tsx` every keyed element is childless, so all keys routed through `jsx` and
no `jsxs` invocation ever carried one. `fixture/page-jsx-keyed-multi.tsx` fixes that: each
keyed row has two children, forcing `jsxs` **with** a key.

```bash
./probe-jsx-multi.exe "…\fixture\page-jsx-keyed-multi.tsx"
NODE_ENV=production ./probe-jsx-multi.exe "…\fixture\page-jsx-keyed-multi.tsx"
```

Production, verbatim (complete — all 7 invocations):

```
distinct: ['jsx', 'jsxs']
{"helper": "jsx", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null, "extraArgs": []}
{"helper": "jsx", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null, "extraArgs": []}
{"helper": "jsxs", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": "r1", "extraArgs": []}
{"helper": "jsx", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null, "extraArgs": []}
{"helper": "jsx", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null, "extraArgs": []}
{"helper": "jsxs", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": "r2", "extraArgs": []}
{"helper": "jsx", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": null, "extraArgs": []}
rendered: Panel#root(keyed-multi)
```

Dev, verbatim (complete; `extraArgs[0]` is `isStaticChildren`, remaining args elided as noted):

```
distinct: ['jsxDEV']
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null} extraArgs[0]=false
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null} extraArgs[0]=false
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": "r1"} extraArgs[0]=true
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null} extraArgs[0]=false
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title"], "childrenKind": "none", "keyPositional": null} extraArgs[0]=false
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": "r2"} extraArgs[0]=true
{"helper": "jsxDEV", "type": "Panel", "propKeys": ["id", "title", "children"], "childrenKind": "array(2)", "keyPositional": null} extraArgs[0]=false
rendered: Panel#root(keyed-multi)
```

**`jsxs(type, props, key)` confirmed by observation**, in both modes: `keyPositional: "r1"` /
`"r2"` alongside `childrenKind: "array(2)"`. The key slot is no longer extrapolated from
React's contract.

This run also sharpens the `jsx`/`jsxs` split. The **last** invocation in each listing is the
root `<Panel id="root">`, which has exactly one JSX child *slot* — the `{rows.map(…)}`
expression — and so routes to **`jsx`** even though `props.children` is an `array(2)`. So the
split is by the number of **child slots written in the source**, not by the runtime array-ness
of `children`. In dev the same distinction shows up as `isStaticChildren`: `true` for literal
multi-child elements, `false` for the root whose children came from an expression. Another
reason `jsx` and `jsxs` cannot be told apart by inspecting `props`.

**The JSX conclusion does not move — it works — but the helper contract is now pinned:**

- **`jsxs` is production-only.** Dev uses `jsxDEV` for *everything*, single and multi-child
  alike, distinguishing them via the `isStaticChildren` argument (`false` vs `true` above).
  `jsxs` was never called in dev no matter the shape of the tree. `jsxsDEV` was registered and
  **never called in either mode** — it does not exist in this transform's output.
- **`jsx` and `jsxs` have the *same* signature: `(type, props, key)`.** `jsxs` does *not* take
  children as a separate array argument. The only difference is that `props.children` is a
  static array (`array(4)`) rather than a single value. So one implementation can back both —
  the facade does not need divergent logic, only the `isStaticChildren` hint if it wants it.
- **`key` is positional, not a prop.** It arrives as the **third argument** and is absent from
  `propKeys` (`keyPositional: "a"` / `"b"` for the `.map`; `propKeys: ["id","title"]`). A
  facade with signature `(type, props)` — as the earlier probes used — **silently drops every
  key**. That is the one place the earlier helper was genuinely wrong.
- **`Fragment` is never called as a helper.** It arrives as the **`type` argument** to
  `jsx`/`jsxs`/`jsxDEV` (`"type": "Fragment"`, `childrenKind: "array(2)"`). It must therefore
  be an exported *value* the facade recognizes as the element type, not a function on the
  helper surface.
- **`jsxDEV` takes six arguments:** `(type, props, key, isStaticChildren, source, self)`. The
  observed `extraArgs` are `[isStaticChildren, null, <module scope>]` — `source` was `null`
  and `self` was the page's own module namespace (visibly carrying its `meta` export).

So **whatever modules the host registers under `react/jsx-runtime` and `react/jsx-dev-runtime`**
must export `jsx(type, props, key)`, `jsxs(type, props, key)`,
`jsxDEV(type, props, key, isStaticChildren, source, self)` and a `Fragment` value. This probe
registered them as standalone modules under those two specifiers, *not* as part of
`@termcraft/runtime`. Whether they are backed by the runtime package, a private internal
module, or something else is Task 4's call — the measurement only constrains what must be
exported under those specifiers, not where it lives.

`rendered: "Panel#root(multi)"` in both modes reflects the stand-in `Panel` ignoring children
by design; the helper log, not the render, is the evidence here.

### 9. Control: JSX from a directory with no `package.json` ancestor

The JSX fixtures live in `fixture/`, which has a `package.json` above it (see the naive
control). The claim that JSX works for real pages leans on it working where the spec puts
pages — a directory with no package tree at all. That control had not been run for JSX.

```bash
D=$(mktemp -d /c/Users/Khmil/AppData/Local/Temp/tc-jsxnopkg-XXXXXX)
cp fixture/page-jsx-multi.tsx "$D/page.tsx"
ls "$D/../package.json"        # ls: cannot access …: No such file or directory
./probe-jsx-multi.exe "$(cygpath -w "$D/page.tsx")"
```

Verbatim:

```
{"ok": true, "distinctHelpers": ["jsxDEV"], "rendered": "Panel#root(multi)"}
```

A multi-child JSX page renders from a directory with no `package.json` and no `node_modules`
anywhere above it. Expected — plugin registration is keyed on the specifier, not the importer's
path — but now measured rather than assumed.

### 8. `process.env.NODE_ENV` is inlined at build time and LIES to a compiled host

Found while checking the multi-child output, which reported `nodeEnv: "development"` even
under `NODE_ENV=production` while the transform demonstrably switched to production helpers.

```bash
bun build --compile src/main-env.ts --outfile probe-env.exe
./probe-env.exe
NODE_ENV=production ./probe-env.exe
NODE_ENV=staging ./probe-env.exe
```

Verbatim:

```
=== NODE_ENV unset ===
{"processEnvDot":"development","processEnvBracket":null,"bunEnvDot":null,"fromOsViaSpread":null}
=== NODE_ENV=production ===
{"processEnvDot":"development","processEnvBracket":"production","bunEnvDot":"production","fromOsViaSpread":"production"}
=== NODE_ENV=staging ===
{"processEnvDot":"development","processEnvBracket":"staging","bunEnvDot":"staging","fromOsViaSpread":"staging"}
```

`process.env.NODE_ENV` accessed with **dot notation is inlined by the bundler as the literal
`"development"`** and reports that forever, regardless of the real environment.
`process.env["NODE_ENV"]`, `Bun.env.NODE_ENV` and `{...process.env}.NODE_ENV` all report the
true runtime value.

**This is a live trap, because the runtime JSX transform follows the *true* value.** A host
that decides which helper subpath to register by reading `process.env.NODE_ENV` **via dot
access** will always read `"development"`, register only `react/jsx-dev-runtime`, and then —
when the binary happens to run under `NODE_ENV=production` — every JSX page dies with
`Cannot find module 'react/jsx-runtime'`, from an env var it never sees.

**A working route exists**: `Bun.env.NODE_ENV`, `process.env["NODE_ENV"]` and
`{...process.env}.NODE_ENV` all returned the true value in all three environments tested. So
the host *can* detect its mode — just not by the idiomatic dot access. This is a footgun, not
an impossibility.

Recommendation, offered as pragmatics rather than necessity: **register both subpaths
unconditionally and do not branch on the mode at all.** It removes a silent, environment-driven
failure whose blast radius is every page, at the cost of one extra `build.module` line. Note
also that the NODE_ENV → helper correspondence was only measured for **unset**, **development**
and **production**; `staging` was exercised against `process.env` (above) but never against the
transform, so which helper an arbitrary non-standard NODE_ENV selects is unmeasured — a further
reason not to branch.

### JSX conclusion

Compiler-owned JSX works, and fallback (a) extends to it cleanly — this now holds for
multi-child elements, fragments and keyed lists, not just the single-child case. Register the
JSX helper alongside `@termcraft/runtime`, exporting `jsx`, `jsxs`, `jsxDEV` and a `Fragment`
value, with `key` accepted as the third positional argument.

**Register both `react/jsx-dev-runtime` and `react/jsx-runtime`, unconditionally** — a
robustness recommendation, not a forced move. The mode *is* detectable (§8: `Bun.env.NODE_ENV`
works), but only outside the idiomatic dot access, and a wrong guess breaks every page from an
env var the host never sees. Registering both costs one line and removes the failure mode.

**Explicit `react/jsx-runtime` imports are not preventable at the resolver level.** Under
`NODE_ENV=production` the generated and author-written specifiers are the same string (§5), so
no resolver could separate them even in principle; in dev the separation is incidental and
porous (§6). This says nothing about whether the *spec* is satisfiable — the spec assigns that
rule to the Gate's source-text scan (`:83-88`), where the distinction is trivial because the
author's import is in the file and the generated one is not. What it does mean is that
resolution provides **no backstop** beneath that scan. See "Which spec claims die".

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

Secondary, same-process number for completeness — `main-measure.ts`, 10 distinct files, most
recent run verbatim:

```json
"importTimingsMs": {
  "all": [14.794, 1.141, 0.46, 0.366, 0.365, 0.372, 0.332, 0.634, 2.965, 0.336],
  "firstColdMs": 14.794,
  "medianMs": 0.46,
  "minMs": 0.332,
  "maxMs": 14.794
}
```

This is a **warm** figure — that harness imports several pages before its loop, so the
transpiler and JIT are hot. It measures "no module-cache hit for this file", not a cold
process, and **it is not the preview cost**. It is also noisy: across three runs of the same
binary the median moved between **0.31 ms and 0.64 ms** and the max between 8.9 ms and 30.3 ms,
so treat it as an order of magnitude (sub-millisecond), never as a figure to quote. The
cold-process number that *does* matter is ~1 ms, above.

**Both numbers are floors, and the absolute ones are soft.** All fixtures are a few lines long;
a real design page with a deep component tree transpiles more slowly. More importantly, the
~44–52 ms spawn figure came from a 94 MB probe that imports a tiny page and prints a string.
The real host additionally carries OpenTUI's native Zig core (Spike B's territory) and whatever
else it initializes, so **the shipped binary will start slower — treat ~45 ms as a floor, not a
budget.** The *ratio* is the robust part: a slower spawn only widens the ~50x gap, so "spawn
dominates, stop optimising the import" holds regardless of where the absolute lands. Task 4
should take the real number from a probe carrying the real runtime.

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

**Register three modules, not one.** A real page is JSX, and the JSX transform generates its
own helper import that must also resolve into the host. Registering `@termcraft/runtime` alone
makes a real JSX page fail with `Cannot find module 'react/jsx-dev-runtime'`. Register the JSX
helper too, under **both** subpaths — `react/jsx-dev-runtime` (used in dev) and
`react/jsx-runtime` (used under `NODE_ENV=production`). Register both *unconditionally*: the
mode is detectable (`Bun.env.NODE_ENV` works), but the idiomatic `process.env.NODE_ENV` dot
access returns the build-time literal `"development"` forever while the transform follows the
real value — so a host that branches on the obvious read breaks every page from an env var it
never sees. One extra line removes the whole failure mode.

Whatever is registered under those two specifiers must export `jsx(type, props, key)`,
`jsxs(type, props, key)` (same signature — `jsxs` only marks that the source wrote multiple
child slots), `jsxDEV(type, props, key, isStaticChildren, source, self)`, and a `Fragment`
**value** that arrives as the element `type`, never as a called helper. `key` is the **third
positional argument**, not a prop — a facade typed `(type, props)` silently drops every key.
Whether those modules are backed by `@termcraft/runtime` or something private is an open
choice; the measurement constrains the exports, not the home.

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

**None.**

The verdict is `YES-WITH-FALLBACK: a`, so the central premise — "designs are code", a project
folder with no `package.json`/`node_modules`, pages imported from arbitrary disk locations —
**survives**, including for real JSX pages (verified from a directory with no `package.json`
ancestor; see the JSX §9 control).

`:92-94` ("the host's compiler owns the JSX transform and resolves any generated JSX helper
internally… Compiler-generated helper resolution is not an authored source import, does not
appear in the saved or exported TSX, and does not widen the Gate allowlist") **survives** — the
host does own it, via the plugin, exactly as described.

An earlier revision of this document claimed that `:679-680` ("Prove compiler-owned JSX support
works while explicit `react/jsx-runtime` and runtime subpath imports fail") **dies**, on the
grounds that the resolver cannot distinguish a generated helper import from an author-written
one. **That conclusion was wrong and has been withdrawn.** The evidence for the premise stands;
the inference from it did not. The spec never located that enforcement in the resolver:

- `:83-88` — the Gate examines "every syntax capable of creating a module edge, including value
  imports, type-only imports, re-exports, side-effect imports, dynamic imports, CommonJS-style
  loads, **and JSX runtime directives**. Only static imports from the exact root specifier are
  accepted." That is a **source-text** scan.
- `:96-98` — "The host repeats the same import scan before linking a page."
- `:161-162` — the facade's declaration environment "does not provide ambient declarations for
  … `react/jsx-runtime`".
- `:679-680` is a **test-policy line in §11.1**. It names no layer.

Enforcement therefore already lives in three places, none of them module resolution. And on
source text the distinction the resolver provably cannot make is trivial: **the author's import
is in the file; the generated one is not** — which is precisely what `:92-94` says. The spec
anticipated this.

### The real finding: resolution offers no second line of defense

What this spike actually establishes is narrower and, for Task 4, more useful:

**The resolver fails open, not closed.** Because the host must register `react/jsx-runtime`
(see §8's recommendation), a page that somehow reached the runtime with an explicit
`react/jsx-runtime` import — bypassing the Gate scan, the host's relink rescan, or arriving
through some path neither covers — would **run normally** rather than failing at load. There is
no backstop underneath the source-text scan. Under `NODE_ENV=production` there provably cannot
be one, since the generated and author-written specifiers are the same string (JSX §5); in dev
the apparent separation is incidental and porous anyway (JSX §6: an author who writes
`react/jsx-dev-runtime` is served happily).

That is a **defense-in-depth gap**, not a dead spec claim. `:47`/`:162` and `:679-680` are all
satisfiable as written, by the layers the spec already assigns them to. Task 4 should not move
that requirement — §3.1 already holds it. Task 4 should instead know that the Gate's source-text
scan is **load-bearing and unbacked**: if it misses a case, nothing downstream catches it.

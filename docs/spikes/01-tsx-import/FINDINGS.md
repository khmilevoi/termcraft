# Spike A — dynamic TSX import with embedded-module resolution

## The question

Can a `bun build --compile` binary, at runtime on Windows, dynamically import an
arbitrary external `.tsx` file from disk, and have *that file's*
`import { … } from '@termcraft/runtime'` resolve to a module embedded in the binary —
with no `node_modules` and no `package.json` anywhere near the `.tsx` file?

Verdict: YES-WITH-FALLBACK: a

The naive path fails exactly as the plan's research predicted. Fallback **(a), a
`Bun.plugin` runtime resolver registered inside the compiled binary, works** — and it is
the only one of the four that does not relocate the page, which turns out to be decisive.

## Environment

- Windows 11, `Microsoft Windows [Version 10.0.26200.8875]`
- `bun 1.3.14` (matches the version the plan recorded on 2026-07-17)
- This spike installs no dependencies, so it has **no `bun.lock`** (per Constraint 5,
  saying so explicitly). The only version that matters here is `bun` itself, reported
  above by `bun --version`.

## Naive: bare specifier

Build and run:

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
fixture technically has a `package.json` ancestor. The real scenario (`.termcraft/pages/foo/`)
has none. To rule out that the ancestor caused — or could have cured — the failure, the same
probe was re-run against an identical page in a temp directory with **no `package.json` and
no `node_modules` ancestor whatsoever**:

```
{"ok":false,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-naive2-zEthFQ/page.tsx","name":"ResolveMessage","message":"Cannot find module '@termcraft/runtime' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-naive2-zEthFQ\\page.tsx'"}
```

Identical failure. Bun does **not** fall back to the binary's embedded modules when the
importing file has no package tree of its own. The naive failure is universal.

### The most useful detail in the failure

The error is a `ResolveMessage` naming the bare specifier — **not** a syntax, parse, or
loader error about the `.tsx` file. Bun found, read, and parsed an external TSX file from an
arbitrary disk location inside a compiled binary without complaint. Only the bare specifier
is unresolved. So the real question was never "can the binary import external TSX" (it can,
natively, with no help); it was only "can the bare specifier be pointed at the embedded
module". That framing is what makes fallback (a) cheap and (b)'s transpile step unnecessary.

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
./probe-a.exe "…\fixture\page.tsx"
```

Verbatim (exit code 0):

```
{"ok":true,"specifier":"file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page.tsx","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

**`Bun.plugin` IS honored inside a compiled binary at runtime.** That was the open question,
and the answer is yes.

This is verified, not a stub, on two independent counts:
- `rendered` is exactly `Panel#root(hello from an external file)`. That string can only be
  produced by the real `Panel` function from the embedded `runtime.ts`, called with the
  external page's own props.
- `meta.kitApiVersion` is `1`, a value the fixture could only obtain by importing
  `kitApiVersion` from the embedded module.

## Fallback (b): transpile-then-import — **WORKS ONLY AFTER CORRECTION**

### (b) as the plan literally wrote it — fails

Entry: `src/main-b-literal.ts` (the plan's snippet verbatim). Verbatim output (exit 1):

```
{"ok":false,"name":"Error","message":"ENOENT: no such file or directory, copyfile '\\B:\\%7EBUN\\root\\runtime.ts'"}
```

This single error confirms **both** traps the plan and constraints flagged:
1. Inside a compiled binary, `import.meta.url` points into Bun's **virtual filesystem**
   (`B:\~BUN\root\`), which does not exist on real disk — so `cpSync` cannot read it.
2. `.pathname` mangled the path: `~` was percent-encoded to `%7E` and a leading `\` was
   prepended. This is the `new URL(...).pathname` trap from Constraint 7.

### (b) corrected — works

Entry: `src/main-b.ts`. The runtime is embedded as an asset (`with { type: "file" }`, which
the plan itself predicted would be needed) and materialized to disk with
`Bun.file(...).text()` + `writeFileSync` instead of `cpSync`. Verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-probe-5A9CKz","runtimeAsset":"B:/~BUN/root/runtime-nge5eq4c.ts","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Note `runtimeAsset: "B:/~BUN/root/runtime-nge5eq4c.ts"` — direct confirmation of the VFS
diagnosis above. `with { type: "file" }` embeds the runtime and yields a VFS path that
`Bun.file()` reads fine; only real-disk APIs like `cpSync` reject it.

**Breaks on relative sibling imports** (see the sibling matrix below).

## Fallback (c): scratch-directory shim — **WORKS FOR PLAIN PAGES, BREAKS ON SIBLINGS**

Entry: `src/main-c.ts`. Correction: the plan's snippet reads
`await Bun.file(runtimeSourcePath).text()` but **never defines `runtimeSourcePath`**;
substituted the embedded asset.

Plain page, verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-shim-zpbxvK","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Page importing a sibling by relative path, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-shim-mzNOjf\\page.tsx'"}
```

The plan explicitly asked whether this survives a page importing a sibling by relative path.
**It does not.** Copying the page alone into a scratch dir severs it from its neighbours.
Surviving would mean copying the whole page directory tree — and then deciding how far the
tree extends, which is an unbounded question on a user's disk.

## Fallback (d): specifier rewrite without transpiling — **WORKS FOR PLAIN PAGES, BREAKS ON SIBLINGS**

Entry: `src/main-d.ts`. Correction: the plan's snippet uses `scratch` and `runtimeAbsPath`
without defining either; both supplied.

Plain page, verbatim (exit 0):

```
{"ok":true,"scratch":"C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-rewrite-vAiOoh","meta":{"title":"Probe page","kitApiVersion":1},"rendered":"Panel#root(hello from an external file)"}
```

Page importing a sibling by relative path, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-rewrite-llBVr7\\page.tsx'"}
```

(d) confirms the naive error's implication — Bun imports external TSX natively and only the
bare specifier needed fixing, so no transpile step is required. But because it must write the
rewritten file *somewhere*, it inherits the same relocation problem as (b) and (c).

## The sibling-import matrix — the finding that separates the four

`fixture/page-with-sibling.tsx` imports both `@termcraft/runtime` (bare) and `./sibling.ts`
(relative). Real design pages plausibly do this.

| Fallback | Plain page | Page with relative sibling import | Relocates the page? |
|---|---|---|---|
| (a) `Bun.plugin` resolver | works | **works** | **no** |
| (b) transpile-then-import | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |
| (c) scratch-dir shim | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |
| (d) specifier rewrite | works | fails (`Cannot find module './sibling.ts'`) | yes → temp |

Fallback (a) with the sibling fixture, verbatim (exit 0):

```
{"ok":true,"specifier":"file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page-with-sibling.tsx","meta":{"title":"Probe page with sibling","kitApiVersion":1},"rendered":"Panel#root(hello + sibling-ok)"}
```

Fallback (b) with the sibling fixture, verbatim (exit 1):

```
{"ok":false,"name":"ResolveMessage","message":"Cannot find module './sibling.ts' from 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-probe-cmX3e7\\page.mjs'"}
```

(b), (c) and (d) all fail for the same structural reason: they solve the bare specifier by
moving the page to a directory the binary controls, which breaks every *other* relative path
the page depends on. (a) solves the bare specifier without moving anything, so relative
imports keep working for free. This is not a tiebreaker on cost — it is a capability
difference.

## Step 7 measurements

Harness: `src/main-measure.ts`, compiled to `probe-measure.exe`, using fallback (a).
Verbatim output:

```json
{
  "importMetaSanity": {
    "importMetaUrl": "file:///C:/Users/Khmil/RustProjects/termcraft/docs/spikes/01-tsx-import/fixture/page-meta.tsx",
    "importMetaDir": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
    "importMetaPath": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-meta.tsx",
    "importMetaDirname": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
    "dirname": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture",
    "filename": "C:\\Users\\Khmil\\RustProjects\\termcraft\\docs\\spikes\\01-tsx-import\\fixture\\page-meta.tsx"
  },
  "moduleCache": {
    "firstRender": "Panel#root(VERSION-1)",
    "secondRenderSameSpecifier": "Panel#root(VERSION-1)",
    "staleOnReimport": true,
    "bustedRenderWithQuery": "Panel#root(VERSION-1)",
    "cacheBustableViaQuery": false
  },
  "importTimingsMs": {
    "all": [0.637, 13.584, 0.63, 0.331, 0.294, 0.253, 2.409, 0.566, 1.283, 30.334],
    "firstColdMs": 0.637,
    "medianMs": 0.637,
    "minMs": 0.253,
    "maxMs": 30.334
  },
  "directoryListingCache": {
    "aRender": "Panel#root(A)",
    "bCreatedAfterDirWasResolved": "FAILED: Cannot find module 'C:\\Users\\Khmil\\AppData\\Local\\Temp\\tc-dircache-rzULyK\\b.tsx' from 'B/~BUN/root/probe-measure.exe'"
  }
}
```

### 1. `import.meta` / `__dirname` sanity — **fully sane**

Every one of `import.meta.url`, `import.meta.dir`, `import.meta.path`,
`import.meta.dirname`, `__dirname` and `__filename` reports the page's **real on-disk
location**, not the binary's VFS and not a temp dir. `__dirname`/`__filename` are defined
even though the page is an ES module (a Bun convenience; do not assume this in Node).

This is a direct consequence of choosing (a): because the page is never relocated, a page can
resolve its own assets relative to itself and get the answer its author expects. Under
(b)/(c)/(d) these would all point into a temp directory instead — a second, quieter way those
fallbacks break real pages.

### 2. Module-cache staleness — **stale, and NOT bustable in-process**

- Re-importing the **same specifier** after changing the file on disk serves the **stale**
  module: `staleOnReimport: true` (still `VERSION-1` after the file was rewritten to
  `VERSION-2`).
- The standard Node cache-busting trick — appending `?v=<timestamp>` — **does not work in
  Bun**: `cacheBustableViaQuery: false`. Bun still returned `VERSION-1`. Anyone porting a
  hot-reload idiom from Node will be bitten by this.
- **A fresh process does pick up the change**, verified separately by running `probe-a.exe`
  twice against one path, editing the file between runs:

```
--- process 1 (EDIT-1) ---
{"ok":true,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-respawn-LAuugh/page.tsx","rendered":"Panel#root(EDIT-1)"}
--- process 2, same path, file changed on disk ---
{"ok":true,"specifier":"file:///C:/Users/Khmil/AppData/Local/Temp/tc-respawn-LAuugh/page.tsx","rendered":"Panel#root(EDIT-2)"}
```

So §4.2's respawn-per-source is not merely a survivable workaround — on this evidence it is
the **only** way to re-read a changed page. In-process hot reload of an edited page is not
available by any means found here.

### 3. Wall-clock per import — **fast; sub-millisecond median**

Ten distinct cold imports (each a fresh file, so no cache hits): median **0.637 ms**, min
0.253 ms, max 30.334 ms. Two outliers (13.6 ms, 30.3 ms) are almost certainly JIT/GC rather
than I/O, as they are not the first import. Preview responsiveness is not import-bound.

Caveat worth carrying forward: these fixtures are a few lines long. A real design page with a
substantial component tree will transpile more slowly, so treat sub-millisecond as a floor,
not a forecast.

### 4. Bonus finding — Bun caches directory listings

Not asked for; found while measuring, and it bit this probe hard enough to be worth recording.
Import `a.tsx` from a directory, then create `b.tsx` **in that same directory** and import it:
Bun cannot find `b.tsx`. It appears to cache the directory listing at first resolve, so files
created afterwards are invisible to that process.

The first draft of the timing harness failed outright for this reason
(`Cannot find module '…\timed-0.tsx'`) until every file was written **before** the first
import of that directory. Combined with finding 2, the rule is: **a process sees the
directory as it was when it first looked, and files as they were when it first read them.**
Respawn cures both. Any future design that writes a page and imports it from a long-lived
process must confront this.

## Discrepancies between the plan and reality

Recorded per Constraint 6. The plan flagged two of these itself; there were four.

1. **(b) `cpSync(new URL("./runtime.ts", import.meta.url).pathname, …)` fails**, with
   `ENOENT … copyfile '\B:\%7EBUN\root\runtime.ts'`. Two independent bugs: the VFS path is
   not on real disk, and `.pathname` mangles it. Corrected to `with { type: "file" }` +
   `Bun.file(...).text()` + `writeFileSync`. The plan predicted the first half.
2. **(c) uses `runtimeSourcePath`, which is never defined** in the snippet. Corrected to the
   embedded asset.
3. **(d) uses `scratch` and `runtimeAbsPath`, neither of which is defined** in the snippet.
   Both supplied.
4. **Deviation from the brief's file list, for auditability:** the brief says to add fallback
   (a) to `src/main.ts`. Instead each fallback got its own entry point (`main-a.ts`,
   `main-b-literal.ts`, `main-b.ts`, `main-c.ts`, `main-d.ts`, `main-measure.ts`), leaving
   `src/main.ts` as the untouched naive probe. Every result above is therefore independently
   reproducible from a single build command, and the naive failure cannot be retroactively
   overwritten by a later fallback.

Two extra fixtures were added beyond the brief's list, both to answer questions the brief
asks: `fixture/page-with-sibling.tsx` + `fixture/sibling.ts` (the relative-sibling question in
Step 6c) and `fixture/page-meta.tsx` (the `import.meta`/`__dirname` question in Step 7).

## What this means, in plain language

**The product's central premise survives.** A compiled `termcraft` binary on Windows can pick
up an arbitrary `.tsx` file from anywhere on disk and run it, with that file's
`import { … } from '@termcraft/runtime'` wired straight to code baked into the binary. The
user's project folder never needs a `package.json` or a `node_modules` — the spec's promise
in §5.8 is keepable, and it was verified against a page in a directory with no package tree
anywhere above it.

It does not work by itself, though. Left alone, Bun looks for `@termcraft/runtime` next to
the page and fails with `Cannot find module`. The fix is small and lives entirely in the
host: register a `Bun.plugin` resolver at startup that serves the runtime from memory, before
importing anything. That is roughly ten lines, and it is the whole difference between "no"
and "yes". `Bun.plugin` being honored inside a compiled binary was the one genuine unknown
here; it is.

Pick **(a)**, and not merely because it is cheapest. The other three all work for a toy page,
and all three break the moment a page imports a file next to it — because they fix the bare
specifier by moving the page somewhere else, which breaks everything else the page points at.
They would also silently redirect `import.meta`/`__dirname` into a temp folder. (a) moves
nothing, so relative imports and `import.meta` just keep working. If pages were guaranteed to
be single self-contained files forever, (d) would be a reasonable second choice; that is not a
guarantee worth betting the design format on.

Two constraints to carry into the host design. First, a process gets **one look** at a page: a
changed file re-imported in the same process serves the old version, and Bun ignores the
`?v=` query trick that works in Node, so there is no in-process hot reload. Second, Bun caches
directory listings, so a page created after that directory was first read is invisible to that
process. Respawning per source (§4.2) resolves both, and was verified to do so — but it is
now load-bearing rather than merely convenient, and it should be treated as a requirement
rather than an implementation detail. Import cost is not a concern: median 0.637 ms for a
cold import, comfortably inside a responsive preview budget, though real pages are larger
than these fixtures.

No spec claims die.

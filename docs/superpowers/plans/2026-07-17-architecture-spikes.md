# Architecture Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the three load-bearing yes/no questions the design spec §4.1 requires be spike-verified before implementation planning, and produce a `package.json` whose versions are verified rather than guessed.

**Architecture:** Three independent throwaway probes, each in a self-contained directory with its own `package.json`, each compiled with `bun build --compile` and run on Windows. **Each spike gets its own dedicated subagent** — the probes share no state, touch no common file, and must run in parallel. A fourth task, run only after all three report, synthesizes findings into a go/no-go and a verified root `package.json`.

**Tech Stack:** Bun 1.3.14 (installed), `@opentui/core` + `@opentui/react` 0.4.5, `typescript`, `@reatom/core` 1001.1.0, `errore` 0.14.1.

## Global Constraints

- **Platform: Windows.** Every probe must be built *and run* on Windows 11. §4.1 names Windows explicitly ("Windows included"); a green result on another OS does not answer the question.
- **Throwaway code.** Probes are evidence, not foundations. They live under `spikes/`, are committed so the result is reproducible and auditable, and are never imported by product code.
- **Empirical, not aspirational.** A spike inverts TDD: you do not know the expected output, and the output *is* the finding. Never write a probe that asserts the answer you want. Record what actually happened, including the exact error text.
- **A "no" is a successful spike.** The purpose is to find out. A subagent that reports "this does not work, here is the error, here are the three fallbacks I tried" has succeeded. Do not work around a failure to make the probe pass — the workaround *is* the finding, and it must be reported as such.
- **No product code.** Do not create `src/`, do not implement any module from `docs/architecture/code-structure.md`. This plan ends at go/no-go.
- **Versions are facts, not guesses.** Every version recorded must come from an installed lockfile, not from memory. Verified on 2026-07-17: `@opentui/core` 0.4.5, `@opentui/react` 0.4.5, `@openai/codex-sdk` 0.144.5, `@anthropic-ai/claude-agent-sdk` 0.3.212, `@reatom/core` 1001.1.0, `errore` 0.14.1, local `bun` 1.3.14.

---

## Known risks the probes must confront

Two risks were found while researching this plan. They are not in the spec, and each subagent must treat them as first-class:

1. **Bun resolves runtime imports relative to the importing file's own directory.** Bun's resolver documentation states: *"At runtime, every import resolves relative to the importing file's own directory… a workspace file imports packages from its own directory tree, independent of the external entrypoint."* This predicts that Spike A's naive path **fails**: a `page.tsx` sitting in `.termcraft/pages/foo/` will look for `@termcraft/runtime` in its own directory tree, not inside the binary. The spec promises the project folder "never grows a `package.json`" and needs no `node_modules`. Spike A exists to find out whether that promise is keepable.

2. **OpenTUI's core is native Zig with TypeScript bindings, at version 0.4.5.** Native artifacts inside a `bun build --compile` single-file executable are a known hard spot, and 0.4.5 is pre-1.0. The spec does not mention either fact. Every probe that compiles OpenTUI into a binary must report whether the native core actually loads from the compiled executable on Windows.

---

## Task 1: Spike A — dynamic TSX import with embedded-module resolution

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 2 and 3 and runs in parallel with them.

**The question:** Can a `bun build --compile` binary, at runtime on Windows, dynamically import an arbitrary external `.tsx` file from disk, and have *that file's* `import { … } from '@termcraft/runtime'` resolve to a module embedded in the binary — with no `node_modules` and no `package.json` anywhere near the `.tsx` file?

**Why it is first:** it has the highest cost of failure. If the answer is no and no fallback works, "designs are code" — the product's central premise — does not survive in its current form.

**Files:**
- Create: `spikes/01-tsx-import/package.json`
- Create: `spikes/01-tsx-import/tsconfig.json`
- Create: `spikes/01-tsx-import/src/runtime.ts` (stands in for `@termcraft/runtime`)
- Create: `spikes/01-tsx-import/src/main.ts` (the compiled binary's entry)
- Create: `spikes/01-tsx-import/fixture/page.tsx` (lives outside the binary; no `node_modules` beside it)
- Create: `spikes/01-tsx-import/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `spikes/01-tsx-import/FINDINGS.md` with a `Verdict:` line reading exactly `YES`, `YES-WITH-FALLBACK`, or `NO`, and — if `YES-WITH-FALLBACK` — a named approach from the list in Step 6. Task 4 reads this file.

- [ ] **Step 1: Scaffold the probe**

```bash
mkdir -p spikes/01-tsx-import/src spikes/01-tsx-import/fixture
cd spikes/01-tsx-import
```

`spikes/01-tsx-import/package.json`:

```json
{
  "name": "spike-tsx-import",
  "private": true,
  "type": "module"
}
```

`spikes/01-tsx-import/tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  }
}
```

- [ ] **Step 2: Write the stand-in runtime and the binary entry**

`spikes/01-tsx-import/src/runtime.ts` — this is what must end up embedded in the binary:

```ts
export const kitApiVersion = 1

export function Panel(props: { id: string; title: string }): string {
  return `Panel#${props.id}(${props.title})`
}
```

`spikes/01-tsx-import/src/main.ts` — the compiled binary. Note the `file://` URL: on Windows a bare `C:\...` path is not a valid import specifier, and skipping this yields a misleading failure.

```ts
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe <absolute-path-to-page.tsx>")
  process.exit(2)
}

const specifier = pathToFileURL(pagePath).href

try {
  const mod = await import(specifier)
  console.log(
    JSON.stringify({
      ok: true,
      specifier,
      meta: mod.meta,
      rendered: typeof mod.default === "function" ? mod.default() : null,
    }),
  )
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      specifier,
      name: (e as Error).name,
      message: (e as Error).message,
    }),
  )
  process.exit(1)
}
```

- [ ] **Step 3: Write the fixture page — the file the binary must import**

`spikes/01-tsx-import/fixture/page.tsx`. It imports the bare specifier `@termcraft/runtime`, exactly as a saved design page will (§5.8 allows no other import). There is deliberately **no** `node_modules` and **no** `package.json` in `fixture/`:

```tsx
import { Panel, kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "Probe page", kitApiVersion }

export default function Page(): string {
  return Panel({ id: "root", title: "hello from an external file" })
}
```

- [ ] **Step 4: Compile the binary and run the naive probe**

```bash
cd spikes/01-tsx-import
bun build --compile src/main.ts --outfile probe.exe
./probe.exe "$(pwd)/fixture/page.tsx"
```

**Do not predict the outcome.** Bun's resolver docs predict failure here (`@termcraft/runtime` resolving relative to `fixture/`, which has no `node_modules`). Record the exact JSON the probe printed, verbatim, including the error `name` and `message`. If it unexpectedly succeeds, that is the finding — verify the `rendered` field actually contains `Panel#root(hello from an external file)` and is not a stub.

- [ ] **Step 5: Record the naive result before trying anything else**

Write `spikes/01-tsx-import/FINDINGS.md` now, with the verbatim output of Step 4 under a `## Naive: bare specifier` heading. Committing the failure before attempting fallbacks is what keeps this honest — it prevents a later fallback success from quietly rewriting history.

- [ ] **Step 6: Try each fallback, in this order, recording every one**

Try all four even after one works — Task 4 needs to compare their costs, and the cheapest working approach is not always the first. For each: record the code, the exact command, and the verbatim output.

**(a) Bun runtime plugin with a custom resolver.** The open question is whether `Bun.plugin` is honored inside a compiled binary at runtime. Add to `src/main.ts` *before* the dynamic import:

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

**(b) Transpile-then-import.** Transpile the page yourself and import the result from a scratch dir the binary controls:

```ts
import { mkdtempSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const scratch = mkdtempSync(join(tmpdir(), "tc-probe-"))
cpSync(new URL("./runtime.ts", import.meta.url).pathname, join(scratch, "runtime.ts"))

const src = await Bun.file(pagePath).text()
const transpiler = new Bun.Transpiler({ loader: "tsx" })
const js = transpiler.transformSync(src).replace(
  /["']@termcraft\/runtime["']/g,
  JSON.stringify(pathToFileURL(join(scratch, "runtime.ts")).href),
)

const out = join(scratch, "page.mjs")
writeFileSync(out, js)
const mod = await import(pathToFileURL(out).href)
console.log(JSON.stringify({ ok: true, rendered: mod.default() }))
```

Note the `cpSync` of `runtime.ts`: inside a compiled binary that path does not exist on disk, so this fallback likely needs the runtime embedded via `with { type: "file" }` instead. Record which.

**(c) Scratch-directory shim.** Copy the page into a scratch dir — **not** the user's project, since the spec forbids `node_modules` there but says nothing about a scratch dir — and give it a real `node_modules` neighbour:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const scratch = mkdtempSync(join(tmpdir(), "tc-shim-"))
const pkgDir = join(scratch, "node_modules", "@termcraft", "runtime")
mkdirSync(pkgDir, { recursive: true })
writeFileSync(
  join(pkgDir, "package.json"),
  JSON.stringify({ name: "@termcraft/runtime", type: "module", main: "index.ts" }),
)
writeFileSync(join(pkgDir, "index.ts"), await Bun.file(runtimeSourcePath).text())

const pageCopy = join(scratch, "page.tsx")
copyFileSync(pagePath, pageCopy)
const mod = await import(pathToFileURL(pageCopy).href)
console.log(JSON.stringify({ ok: true, rendered: mod.default() }))
```

Also report whether this survives the page importing a sibling file by *relative* path — real pages may.

**(d) Specifier rewrite without transpiling.** The cheapest option if Bun imports external TSX natively and only the bare specifier is the problem:

```ts
const src = await Bun.file(pagePath).text()
const rewritten = src.replace(
  /from\s+["']@termcraft\/runtime["']/g,
  `from ${JSON.stringify(pathToFileURL(runtimeAbsPath).href)}`,
)
const out = join(scratch, "page.tsx")
writeFileSync(out, rewritten)
const mod = await import(pathToFileURL(out).href)
```

- [ ] **Step 7: Answer the question that actually matters**

For whichever approaches worked, record:
- Does `import.meta`/`__dirname` inside the page still behave sanely?
- Does a *second* import of a *changed* file pick up the change, or does Bun's module cache serve the stale one? The host respawns per source (§4.2), so a cache that cannot be busted is survivable — but Task 4 must know.
- Wall-clock time for one import, measured with `performance.now()`. Preview responsiveness depends on it.

- [ ] **Step 8: Finalize FINDINGS.md and commit**

`spikes/01-tsx-import/FINDINGS.md` must contain, in this order: the question; `Verdict: YES` / `YES-WITH-FALLBACK: <letter>` / `NO`; the naive result verbatim; each fallback with verbatim output; the Step 7 measurements; and a plain-language paragraph a reader can act on. If the verdict is `NO`, state explicitly which spec claims die with it.

```bash
git add spikes/01-tsx-import
git commit -m "spike: dynamic TSX import with embedded-module resolution"
```

---

## Task 2: Spike B — styled cell-frame capture from the headless renderer

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1 and 3 and runs in parallel with them.

**The question:** Can OpenTUI render headlessly at a fixed size with no TTY, from inside a `bun build --compile` binary on Windows, and yield **per-cell** char + fg + bg + attributes as §4.2's host protocol requires?

**What research already established** — the subagent starts here rather than from zero. `@opentui/core/testing` exports `createTestRenderer`:

```ts
import { createTestRenderer } from "@opentui/core/testing"

const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame, resize } =
  await createTestRenderer({ width: 80, height: 24 })
```

Documented members: `renderOnce()`, `flush()`, `waitFor()`, `waitForFrame()`, `captureCharFrame()`, `captureSpans()`, `externalOutput.takeText()`, `getNativeStats()`, `resize()`, `mockInput`, `mockMouse`. It defaults to no physical terminal: `screenMode: "main-screen"`, `consoleMode: "disabled"`, `externalOutputMode: "passthrough"`, native memory output.

So the question is **not** "is headless rendering possible" — it is which of these carries style, and whether any of it survives `--compile`. `captureCharFrame()` is documented as returning the terminal state **as a string** (chars only — likely sufficient for export's ASCII snapshots, §3.7). `captureSpans()` is documented as reading **styled** lines and cursor state — whether "span" means per-cell attributes or coarser line runs is the crux.

**Files:**
- Create: `spikes/02-frame-capture/package.json`
- Create: `spikes/02-frame-capture/tsconfig.json`
- Create: `spikes/02-frame-capture/src/main.ts`
- Create: `spikes/02-frame-capture/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `spikes/02-frame-capture/FINDINGS.md` with a `Verdict:` line reading exactly `YES`, `PARTIAL`, or `NO`, plus a `Shape:` block giving the literal TypeScript type `captureSpans()` returns. Task 4 reads this file.

- [ ] **Step 1: Scaffold and install**

```bash
mkdir -p spikes/02-frame-capture/src
cd spikes/02-frame-capture
bun init -y
bun add @opentui/core@0.4.5
```

Record the resolved version from `bun.lock` verbatim — Task 4 needs the fact, not the range.

- [ ] **Step 2: Probe headless capture under `bun run` first**

Establish the baseline before adding the `--compile` variable. Two variables at once produce an unattributable failure.

`spikes/02-frame-capture/src/main.ts`:

```ts
import { createTestRenderer } from "@opentui/core/testing"
import { Text } from "@opentui/core"

const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
  width: 40,
  height: 10,
})

renderer.root.add(Text({ content: "Hello" }))
await renderOnce()

console.log("--- captureCharFrame ---")
console.log(captureCharFrame())

const mod = await import("@opentui/core/testing")
console.log("--- testing exports ---")
console.log(Object.keys(mod).join(", "))

renderer.destroy()
```

```bash
bun run src/main.ts
```

Record the output verbatim. If `Text({ content })` is not the real 0.4.5 signature, find the correct one in `node_modules/@opentui/core` — the installed package is the authority, not this plan.

- [ ] **Step 3: Find out what carries style**

Render something with an explicit foreground, background, and an attribute (bold), then dump both capture paths. Consult `node_modules/@opentui/core/dist/**/*.d.ts` for the real `captureSpans` signature and the real styling props, and use them:

```ts
console.log("--- captureSpans ---")
console.log(JSON.stringify(captureSpans(), null, 2))
```

Answer precisely:
- Does `captureSpans()` return **per-cell** records, or **runs** of styled text per line?
- Are fg/bg RGB triples, palette indices, or strings?
- Which attributes survive (bold, dim, italic, underline, reverse)?
- Can a full 80×24 styled grid be reconstructed from it losslessly? **This is the verdict question** — §4.2's protocol ships "styled cell frames (char + fg + bg + attributes)".
- Record the literal `.d.ts` type under `Shape:` in FINDINGS.md.

- [ ] **Step 4: Compile it and find out if the native Zig core survives**

The highest-risk step in this task, and one the spec never mentions.

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe
```

Record verbatim. Specifically: does the native core load from the single-file executable on Windows, or does it look for a `.node`/`.dll` beside the binary? If it fails, report the exact error and whether `--compile`'s asset embedding (`with { type: "file" }`, `Bun.embeddedFiles`) offers a route. A `NO` here is a major finding: it means the shell, the design host, and export all need a different packaging story than §4.1 describes.

- [ ] **Step 5: Measure and probe the two things §4.2 also needs**

- `resize(120, 40)` then re-render: does capture track the new size? (§4.2 forwards resize.)
- `mockMouse`: can a click be delivered and a hit resolved? (Not this spike's verdict — §3.5 defers interactive mode to v1.0 — but a cheap fact to bank while the harness is hot.)
- Wall-clock for `createTestRenderer` + `renderOnce` + capture at 80×24, via `performance.now()`. Export renders a fresh host per page **per size** (§3.7); this number decides whether export is seconds or minutes.

- [ ] **Step 6: Judge `/testing` as production infrastructure**

State plainly in FINDINGS.md: the spec's design host needs this capability **in production**, but OpenTUI ships it under `@opentui/core/testing` at version **0.4.5**. Testing-scoped APIs carry no stability guarantee, and pre-1.0 packages break minor-to-minor. Report whether a non-testing headless path exists in the installed package. Do not soften this — it is a real architectural exposure and Task 4 must weigh it.

- [ ] **Step 7: Finalize FINDINGS.md and commit**

```bash
git add spikes/02-frame-capture
git commit -m "spike: styled cell-frame capture from the OpenTUI headless renderer"
```

---

## Task 3: Spike C — TypeScript check inside the compiled binary

> **Dedicated subagent.** This task is one subagent's entire assignment. It shares nothing with Tasks 1 and 2 and runs in parallel with them.

**The question:** Can the TypeScript compiler type-check an external `page.tsx` from inside a `bun build --compile` binary on Windows, with the lib `.d.ts` files and `@termcraft/runtime`'s types embedded — and fast enough to sit inside a turn?

**Why it matters:** the Gate is the correctness wall. §4.2: *"correctness comes from the gate only accepting what landed in staging and validated."* No type check inside the binary, no Gate as specified.

**The hard part:** `ts.createProgram` reaches for `lib.*.d.ts` on the real filesystem, normally under `node_modules/typescript/lib/`. A compiled binary has no such directory. This spike stands or falls on a custom `CompilerHost` served from embedded files.

**Files:**
- Create: `spikes/03-tsc-in-binary/package.json`
- Create: `spikes/03-tsc-in-binary/tsconfig.json`
- Create: `spikes/03-tsc-in-binary/src/main.ts`
- Create: `spikes/03-tsc-in-binary/src/runtime.d.ts`
- Create: `spikes/03-tsc-in-binary/fixture/good.tsx`
- Create: `spikes/03-tsc-in-binary/fixture/bad.tsx`
- Create: `spikes/03-tsc-in-binary/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `spikes/03-tsc-in-binary/FINDINGS.md` with a `Verdict:` line reading exactly `YES`, `YES-WITH-FALLBACK`, or `NO`, and a `Latency:` line giving milliseconds for one cold check. Task 4 reads this file.

- [ ] **Step 1: Scaffold and install**

```bash
mkdir -p spikes/03-tsc-in-binary/src spikes/03-tsc-in-binary/fixture
cd spikes/03-tsc-in-binary
bun init -y
bun add typescript
```

Record the resolved `typescript` version from `bun.lock` verbatim.

- [ ] **Step 2: Write both fixtures — one that must pass, one that must fail**

A checker that reports zero errors on everything is indistinguishable from a checker that does not run. The `bad.tsx` fixture is what proves the check is real.

`spikes/03-tsc-in-binary/src/runtime.d.ts` — the embedded types for the facade:

```ts
declare module "@termcraft/runtime" {
  export const kitApiVersion: number
  export function Panel(props: { id: string; title: string }): string
}
```

`spikes/03-tsc-in-binary/fixture/good.tsx`:

```tsx
import { Panel } from "@termcraft/runtime"

export const meta = { title: "Good page" }
export default function Page(): string {
  return Panel({ id: "root", title: "fine" })
}
```

`spikes/03-tsc-in-binary/fixture/bad.tsx` — `title` is a number where a string is declared, and `id` is missing:

```tsx
import { Panel } from "@termcraft/runtime"

export const meta = { title: "Bad page" }
export default function Page(): string {
  return Panel({ title: 42 })
}
```

- [ ] **Step 3: Type-check under `bun run` first**

Baseline before `--compile`. Write `src/main.ts` using `ts.createProgram` with the default host, check both fixtures, print diagnostics as JSON:

```ts
import ts from "typescript"

const file = process.argv[2]
const program = ts.createProgram([file], {
  strict: true,
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
})
const diags = ts.getPreEmitDiagnostics(program)
console.log(
  JSON.stringify(
    diags.map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    })),
    null,
    2,
  ),
)
```

```bash
bun run src/main.ts fixture/good.tsx
bun run src/main.ts fixture/bad.tsx
```

Expected shape: `good.tsx` yields no `@termcraft/runtime`-related errors; `bad.tsx` yields a `2345`/`2322`-family type error naming `title`. Record both verbatim. If `good.tsx` reports missing-lib errors, that is the embedding problem arriving early — note it and continue.

- [ ] **Step 4: Embed the lib files and serve them from a custom CompilerHost**

The crux. Embed the lib `.d.ts` files with Bun's file-import attribute so they live inside the binary, then override `getSourceFile`/`fileExists`/`readFile` to serve them and `@termcraft/runtime`'s types:

```ts
import libEsnextPath from "../node_modules/typescript/lib/lib.esnext.d.ts" with { type: "file" }
import libDecoratorsPath from "../node_modules/typescript/lib/lib.decorators.d.ts" with { type: "file" }
```

Determine the true set of lib files ESNext pulls in — `lib.esnext.d.ts` is a chain of `/// <reference lib="..." />` directives, and missing one surfaces as a confusing "cannot find name" rather than "file not found". Enumerate `node_modules/typescript/lib/lib.*.d.ts`, embed what the chain needs, and record the final list. Then:

```bash
bun build --compile src/main.ts --outfile probe.exe
./probe.exe fixture/good.tsx
./probe.exe fixture/bad.tsx
```

Record verbatim. The verdict requires **both**: clean on `good.tsx` *and* the correct error on `bad.tsx`.

- [ ] **Step 5: Measure latency — this is half the finding**

Time one cold check of `good.tsx` from the compiled binary with `performance.now()`, three runs, record all three. Then note how it composes with the turn: the Gate runs on every attempt, and §9 allows up to 3 retries, so the user waits for this number up to four times per turn. A `YES` at 8 seconds is a different answer than a `YES` at 300ms, and Task 4 must be told which one it got.

- [ ] **Step 6: Finalize FINDINGS.md and commit**

Include: the question; `Verdict:`; `Latency:`; the embedded lib file list; verbatim output for both fixtures under `bun run` and under `--compile`; and, if a custom host was needed, the working `CompilerHost` code in full.

```bash
git add spikes/03-tsc-in-binary
git commit -m "spike: TypeScript check inside the compiled binary"
```

---

## Task 4: Synthesis — go/no-go and a verified package.json

> **Not a subagent task.** Run this only after all three subagents have reported. It is a judgment call over their evidence and belongs in the main session with the user.

**Files:**
- Create: `docs/superpowers/spikes/2026-07-17-findings.md`
- Create: `package.json`
- Create: `tsconfig.json`

**Interfaces:**
- Consumes: the `Verdict:` lines from all three `FINDINGS.md` files, plus Spike A's fallback letter, Spike B's `Shape:` block, and Spike C's `Latency:`.
- Produces: a go/no-go recommendation and the repository's first real `package.json`.

- [ ] **Step 1: Collect the three verdicts**

```bash
grep -r "^Verdict:" spikes/*/FINDINGS.md
```

- [ ] **Step 2: Write the consolidated findings**

`docs/superpowers/spikes/2026-07-17-findings.md`: one section per spike — question, verdict, evidence, and consequence. Then a table mapping each `NO` or `PARTIAL` to the spec claims it invalidates, by section number. Be specific: "§4.1's embedded-module promise does not hold; the project folder needs a scratch shim" is actionable, "some risk remains" is not.

- [ ] **Step 3: Write `package.json` and `tsconfig.json` from verified versions only**

Every version comes from a spike's lockfile. `tsconfig.json` must include `"ESNext.Disposable"` in `lib` — `errore`'s `AsyncDisposableStack` needs it, and `CLAUDE.md` makes `errore` mandatory:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "ESNext.Disposable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true
  }
}
```

- [ ] **Step 4: Make the call, out loud**

State one of three, with reasons:
- **Go** — all three green; MVP implementation planning may start.
- **Go with amendments** — name every spec section that must change first, by number. Implementation planning waits for those edits.
- **No-go** — a premise failed. Name it, and name what the architecture becomes without it.

Then update `docs/architecture/code-structure.md` and the affected specs if — and only if — a finding contradicts them.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/spikes package.json tsconfig.json
git commit -m "docs: record architecture spike findings and the verified toolchain"
```

---

## Dispatch

Tasks 1, 2, and 3 are fully independent — separate directories, separate `package.json` files, no shared state, no ordering between them. **Dispatch three subagents in parallel, one per spike.** Each subagent's brief is its task section verbatim plus the Global Constraints and the Known Risks section.

Task 4 runs after all three report, in the main session, with the user.

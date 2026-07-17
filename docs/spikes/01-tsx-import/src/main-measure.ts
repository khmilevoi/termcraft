// Step 7 harness. Uses fallback (a) — the runtime plugin — since that is the only
// approach that imports the page at its original on-disk location.
//
// Measures:
//  1. import.meta / __dirname sanity inside a dynamically imported external page
//  2. module-cache staleness: re-import of a CHANGED file, same specifier vs cache-busted
//  3. wall-clock per import via performance.now()
//  4. directory-listing cache: is a file created in an already-resolved directory visible?
import { plugin } from "bun"
import * as runtime from "./runtime.ts"
import { pathToFileURL } from "node:url"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

plugin({
  name: "termcraft-runtime-resolver",
  setup(build) {
    build.module("@termcraft/runtime", () => ({
      exports: runtime,
      loader: "object",
    }))
  },
})

const metaPagePath = process.argv[2]
if (!metaPagePath) {
  console.error("usage: probe-measure <absolute-path-to-page-meta.tsx>")
  process.exit(2)
}

const results: Record<string, unknown> = {}
const pageSource = (label: string) => `
import { Panel } from "@termcraft/runtime"
export default function Page(): string {
  return Panel({ id: "root", title: ${JSON.stringify(label)} })
}
`

// --- 1. import.meta / __dirname sanity -------------------------------------------------
try {
  const metaMod = await import(pathToFileURL(metaPagePath).href)
  results.importMetaSanity = metaMod.probeInfo()
} catch (e) {
  results.importMetaSanity = { error: (e as Error).message }
}

// --- 2. module-cache staleness ---------------------------------------------------------
// Its own scratch dir, so the directory-listing question below stays isolated.
try {
  const scratch = mkdtempSync(join(tmpdir(), "tc-cache-"))
  const mutable = join(scratch, "mutable.tsx")

  writeFileSync(mutable, pageSource("VERSION-1"))
  const first = await import(pathToFileURL(mutable).href)
  const firstRender = first.default()

  // Rewrite the SAME path with different content, then re-import the SAME specifier.
  writeFileSync(mutable, pageSource("VERSION-2"))
  const second = await import(pathToFileURL(mutable).href)
  const secondRender = second.default()

  // Re-import with a cache-busting query string.
  const busted = await import(`${pathToFileURL(mutable).href}?v=${Date.now()}`)
  const bustedRender = busted.default()

  results.moduleCache = {
    firstRender,
    secondRenderSameSpecifier: secondRender,
    staleOnReimport: secondRender === firstRender,
    bustedRenderWithQuery: bustedRender,
    cacheBustableViaQuery: bustedRender !== firstRender,
  }
} catch (e) {
  results.moduleCache = { error: (e as Error).message }
}

// --- 3. wall-clock per import ----------------------------------------------------------
// Fresh dir; ALL files written BEFORE the first import of this dir, to avoid the
// directory-listing cache measured in part 4.
try {
  const timingDir = mkdtempSync(join(tmpdir(), "tc-timing-"))
  const paths: string[] = []
  for (let i = 0; i < 10; i++) {
    const p = join(timingDir, `timed-${i}.tsx`)
    writeFileSync(p, pageSource(`timed-${i}`))
    paths.push(p)
  }

  const timings: number[] = []
  for (const p of paths) {
    const t0 = performance.now()
    const m = await import(pathToFileURL(p).href)
    m.default()
    timings.push(performance.now() - t0)
  }

  const sorted = [...timings].sort((a, b) => a - b)
  results.importTimingsMs = {
    all: timings.map((t) => Number(t.toFixed(3))),
    firstColdMs: Number(timings[0]!.toFixed(3)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3)),
    minMs: Number(sorted[0]!.toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(3)),
  }
} catch (e) {
  results.importTimingsMs = { error: (e as Error).message }
}

// --- 4. directory-listing cache --------------------------------------------------------
// Import a.tsx from a fresh dir, THEN create b.tsx in that same dir and import it.
try {
  const dir = mkdtempSync(join(tmpdir(), "tc-dircache-"))
  const a = join(dir, "a.tsx")
  writeFileSync(a, pageSource("A"))
  const modA = await import(pathToFileURL(a).href)

  const b = join(dir, "b.tsx")
  writeFileSync(b, pageSource("B"))
  let bResult: string
  try {
    const modB = await import(pathToFileURL(b).href)
    bResult = `ok: ${modB.default()}`
  } catch (e) {
    bResult = `FAILED: ${(e as Error).message}`
  }

  results.directoryListingCache = {
    aRender: modA.default(),
    bCreatedAfterDirWasResolved: bResult,
  }
} catch (e) {
  results.directoryListingCache = { error: (e as Error).message }
}

console.log(JSON.stringify(results, null, 2))

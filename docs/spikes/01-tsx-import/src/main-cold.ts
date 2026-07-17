// Fix 2: a genuinely COLD first import. Unlike main-measure.ts (which imported four pages
// before its timing loop, leaving the transpiler and JIT warm), this binary imports exactly
// ONE page and exits. Its own numbers plus the parent-measured wall clock in spawn-bench.ts
// give the real cost of one preview: spawn + first import + render.
import { plugin } from "bun"
import * as runtime from "./runtime.ts"
import { pathToFileURL } from "node:url"

plugin({
  name: "termcraft-runtime-resolver",
  setup(build) {
    build.module("@termcraft/runtime", () => ({ exports: runtime, loader: "object" }))
  },
})

// Registered so JSX pages resolve; `dev-only` is what the JSX probe found the transform emits.
const h = (type: unknown, props: Record<string, unknown>): unknown =>
  typeof type === "function" ? (type as (p: unknown) => unknown)(props) : String(type)
plugin({
  name: "termcraft-jsx-runtime",
  setup(build) {
    build.module("react/jsx-dev-runtime", () => ({
      exports: { jsx: h, jsxs: h, jsxDEV: h, Fragment: (p: { children?: unknown }) => p?.children },
      loader: "object",
    }))
  },
})

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-cold <absolute-path-to-page.tsx>")
  process.exit(2)
}

// performance.now() is relative to process start, so this captures runtime init too.
const beforeImport = performance.now()
const mod = await import(pathToFileURL(pagePath).href)
const rendered = typeof mod.default === "function" ? mod.default() : null
const afterRender = performance.now()

console.log(
  JSON.stringify({
    ok: true,
    msBeforeImportStarted: Number(beforeImport.toFixed(3)),
    firstImportAndRenderMs: Number((afterRender - beforeImport).toFixed(3)),
    totalInProcessMs: Number(afterRender.toFixed(3)),
    rendered,
  }),
)

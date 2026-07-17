// Fallback (b), the plan's code EXACTLY as written, to record what it actually does.
// The plan itself flags `cpSync(new URL("./runtime.ts", import.meta.url).pathname, ...)`
// as suspect inside a compiled binary. Run it literally first; correct it in main-b.ts.
import { mkdtempSync, writeFileSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-b-literal <absolute-path-to-page.tsx>")
  process.exit(2)
}

try {
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
} catch (e) {
  console.log(
    JSON.stringify({
      ok: false,
      name: (e as Error).name,
      message: (e as Error).message,
    }),
  )
  process.exit(1)
}

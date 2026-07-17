// Fallback (d), CORRECTED: specifier rewrite WITHOUT transpiling.
//
// Corrections vs the plan's snippet, recorded in FINDINGS.md: the snippet uses `scratch`
// and `runtimeAbsPath` without defining either. Both supplied here; the runtime comes from
// the embedded asset materialized onto disk, since inside a compiled binary there is no
// runtime.ts on the real filesystem.
import runtimeAsset from "./runtime.ts" with { type: "file" }
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-d <absolute-path-to-page.tsx>")
  process.exit(2)
}

try {
  const scratch = mkdtempSync(join(tmpdir(), "tc-rewrite-"))
  const runtimeAbsPath = join(scratch, "runtime.ts")
  writeFileSync(runtimeAbsPath, await Bun.file(runtimeAsset).text())

  const src = await Bun.file(pagePath).text()
  const rewritten = src.replace(
    /from\s+["']@termcraft\/runtime["']/g,
    `from ${JSON.stringify(pathToFileURL(runtimeAbsPath).href)}`,
  )

  const out = join(scratch, "page.tsx")
  writeFileSync(out, rewritten)
  const mod = await import(pathToFileURL(out).href)
  console.log(
    JSON.stringify({
      ok: true,
      scratch,
      meta: mod.meta,
      rendered: mod.default(),
    }),
  )
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

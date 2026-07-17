// Fallback (c), CORRECTED: scratch-directory shim with a real node_modules neighbour.
//
// Correction vs the plan's snippet, recorded in FINDINGS.md: the plan reads
// `await Bun.file(runtimeSourcePath).text()` but never defines `runtimeSourcePath`.
// Substituted the embedded asset (`with { type: "file" }`), the only thing that exists
// inside a compiled binary.
import runtimeAsset from "./runtime.ts" with { type: "file" }
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-c <absolute-path-to-page.tsx>")
  process.exit(2)
}

try {
  const scratch = mkdtempSync(join(tmpdir(), "tc-shim-"))
  const pkgDir = join(scratch, "node_modules", "@termcraft", "runtime")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@termcraft/runtime", type: "module", main: "index.ts" }),
  )
  writeFileSync(join(pkgDir, "index.ts"), await Bun.file(runtimeAsset).text())

  const pageCopy = join(scratch, "page.tsx")
  copyFileSync(pagePath, pageCopy)
  const mod = await import(pathToFileURL(pageCopy).href)
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

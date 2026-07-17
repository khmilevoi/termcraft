// Fallback (b), CORRECTED: transpile-then-import.
//
// Two corrections vs the plan's snippet, both recorded in FINDINGS.md:
//  1. `new URL("./runtime.ts", import.meta.url).pathname` does not exist on disk inside a
//     compiled binary (it points into Bun's VFS) AND `.pathname` mangles the Windows path.
//     Replaced with an embedded asset via `with { type: "file" }`, which the plan predicted.
//  2. Read the embedded asset with Bun.file(...).text() + writeFileSync rather than cpSync,
//     because the source lives in the VFS, not on disk.
import runtimeAsset from "./runtime.ts" with { type: "file" }
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const pagePath = process.argv[2]
if (!pagePath) {
  console.error("usage: probe-b <absolute-path-to-page.tsx>")
  process.exit(2)
}

try {
  const scratch = mkdtempSync(join(tmpdir(), "tc-probe-"))

  // Materialize the embedded runtime out of the VFS onto real disk.
  const runtimeOnDisk = join(scratch, "runtime.ts")
  writeFileSync(runtimeOnDisk, await Bun.file(runtimeAsset).text())

  const src = await Bun.file(pagePath).text()
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  const js = transpiler.transformSync(src).replace(
    /["']@termcraft\/runtime["']/g,
    JSON.stringify(pathToFileURL(runtimeOnDisk).href),
  )

  const out = join(scratch, "page.mjs")
  writeFileSync(out, js)
  const mod = await import(pathToFileURL(out).href)
  console.log(
    JSON.stringify({
      ok: true,
      scratch,
      runtimeAsset,
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

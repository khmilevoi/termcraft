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

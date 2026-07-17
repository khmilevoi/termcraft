// Fixture for Step 7: reports what `import.meta` / `__dirname` look like from inside a
// page that was dynamically imported from disk by a compiled binary.
import { kitApiVersion } from "@termcraft/runtime"

export const meta = { title: "Meta probe", kitApiVersion }

export function probeInfo(): Record<string, unknown> {
  return {
    importMetaUrl: import.meta.url,
    importMetaDir: (import.meta as unknown as { dir?: string }).dir ?? null,
    importMetaPath: (import.meta as unknown as { path?: string }).path ?? null,
    importMetaDirname: (import.meta as unknown as { dirname?: string }).dirname ?? null,
    dirname: typeof __dirname !== "undefined" ? __dirname : null,
    filename: typeof __filename !== "undefined" ? __filename : null,
  }
}

export default function Page(): string {
  return "meta-page"
}

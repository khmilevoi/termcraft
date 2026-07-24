// Ambient module declarations for Bun's `with { type: "file" }` asset imports (Bun's own
// documented pattern for typing arbitrary-extension imports, e.g. its `*.svg` example) — both
// resolve to the plain string path `with { type: "file" }` always returns.
//
// `*.exe`: `scripts/embed-assets.ts` imports the platform package's `tsc.exe` directly; a
// bare `.exe` has no special meaning to TypeScript, so this alone is enough to type it.
//
// `*.txt`: `scripts/tsc-libs.generated.ts` imports the curated lib chain from RENAMED
// `<lib-name>.d.ts.txt` copies (`scripts/tsc-lib-sources/`), not the real `.d.ts` files —
// TypeScript's own TS2846 ("a declaration file cannot be imported without 'import type'")
// rejects importing a literal `.d.ts`-suffixed file as a value, regardless of import
// attributes or ambient declarations targeting `*.d.ts` (verified; see the WP-11 report). The
// `.txt` extension is never special-cased, so the rename sidesteps the rule entirely.
declare module "*.exe" {
  const path: string;
  export default path;
}

declare module "*.txt" {
  const path: string;
  export default path;
}

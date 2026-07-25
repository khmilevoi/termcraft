// Regenerates `src/runtime/generated/runtime-dts.ts`: the ambient `@termcraft/runtime`
// declaration the Gate's hermetic type check (`src/gate/model/type-check.ts`) hands the Go
// compiler, and the same text the agent prompt library ships as its runtime API reference
// (phase-8 design §WP-2, §WP-3). Run `bun run scripts/gen-runtime-dts.ts` after any change to
// `src/runtime`'s public surface; `--stdout` prints the text instead of writing the file, which
// is how `src/runtime/generated/runtime-dts.test.ts` proves the committed artifact has not
// drifted. The output is COMMITTED rather than generated at install time: it is small, it is
// read by humans reviewing what the agent is told, and the drift test is the staleness guard.
// (Phase 8 deleted the one generated artifact this repository used to keep gitignored and
// rebuild from a `postinstall` hook — that shape broke a fresh clone, because the tree could
// not even be imported until the hook had run.)
//
// ── WHY declaration emit + flattening, and not the obvious alternatives ────────────────────
//
// The Gate's type check is HERMETIC (Spike C, `type-check.ts`): the synthesized tsconfig sets
// `types: []`, `moduleResolution: "bundler"`, `files: [candidate, runtimeDts]`, runs with
// `cwd = os.tmpdir()`, and the virtual FS answers `undefined` ("read the real disk") for
// everything but its three synthetic files. There is no `node_modules` reachable from
// `os.tmpdir()`, so nothing this declaration references by bare specifier resolves at check
// time. Three consequences shaped the design, each settled from evidence rather than guessed:
//
//  1. A NAIVE PER-FILE EMIT CANNOT BE THE ARTIFACT. `tsc --emitDeclarationOnly` over
//     `src/runtime/index.ts` produces 21 files that re-export each other through RELATIVE
//     specifiers (`./types`, `./model/reatom`, `./ui/gauge`). An ambient module declaration
//     may not name a relative module (`Ambient module declaration cannot specify relative
//     module name`), so the 21 chunks are FLATTENED into one `declare module "@termcraft/runtime"`
//     block: every chunk's declarations are re-emitted verbatim with their `export` modifier
//     stripped (so they become block-local), and `index.d.ts`'s own re-export list is replayed
//     as bare `export { … }` / `export type { … }` statements. That reproduces the facade's
//     public surface EXACTLY — `activeTokens`, which `model/tokens.ts` exports but
//     `index.ts` does not, stays internal, as it must.
//
//  2. THE EXTERNAL TYPE SURFACE STAYS BY REFERENCE, NOT INLINED. The emitted declarations
//     reference three external identities: `@reatom/core` (`Atom`, `Computed`, `AtomLike`,
//     `Ext` plus the re-exported `atom`/`computed`/`action`/`wrap`/`with*` values),
//     `@reatom/react` (`reatomComponent`), and `@opentui/react/jsx-runtime` +
//     `/jsx-dev-runtime` (`jsx`/`jsxs`/`jsxDEV`/`Fragment`). Those `import` statements are
//     hoisted, deduped and kept AS SPECIFIERS inside the ambient block. Inlining the real
//     declarations instead was rejected on measured size: `node_modules/@reatom/core/dist/
//     index.d.ts` alone is ~296 KB, and this same string is the agent's runtime reference in
//     WP-3 — a 300 KB prompt attachment is not a trade worth making for type fidelity the
//     Gate does not need (see 3). Hand-writing structural stand-ins for those types was
//     rejected outright: fabricated types are exactly what the repository's honest-values
//     rule forbids.
//
//  3. THE UNRESOLVED SPECIFIERS ARE HARMLESS TO THE GATE, AND THAT WAS VERIFIED, NOT ASSUMED.
//     The runtime declaration is served to the compiler as a `.d.ts`, and the synthesized
//     tsconfig sets `skipLibCheck: true`, so a specifier that does not resolve raises no
//     diagnostic and the imported names degrade to the error type (`any`-like). The
//     consequence is precise and bounded: a page's PROP types are still fully checked (every
//     `*Props` interface is declared locally in the block), while Reatom call signatures and
//     component RETURN types go unchecked. `src/gate/model/type-check.test.ts` pins both
//     halves of that behaviour — a valid fixture page comes back clean, and a page with a
//     deliberate prop-type error still yields a `type` diagnostic. Teaching the Gate a
//     `paths` map into the real `node_modules` (design §WP-1: "that path is configuration the
//     Gate supplies") is the upgrade path if full external fidelity is ever wanted; it is
//     deliberately NOT taken here, because it would bind the shipped npm package's type
//     check to a `node_modules` layout the installed CLI has no reason to keep.
//
//  4. JSX NEEDED ONE ADDITIVE GATE CHANGE, ALSO MEASURED RATHER THAN ASSUMED. Probed against
//     the real emitted declaration: with the Gate's `jsx: "react-jsx"` and no `jsxImportSource`,
//     a valid JSX page fails with `TS2875 This JSX tag requires the module path
//     'react/jsx-runtime' to exist` — the implicit factory module is `react`, unreachable from
//     `os.tmpdir()`. So `synthesizeTsconfig` now also sets `jsxImportSource:
//     "@termcraft/runtime"` and this generator emits the two sub-modules TypeScript then looks
//     for (`buildJsxSubmodules`, whose comment records why those names and bodies are sourced
//     rather than chosen). With that pair in place the same page comes back CLEAN, a wrong prop
//     type yields TS2322, and an unknown prop yields TS2322 — i.e. the check is real, not
//     silently disabled.
//
// `React.ReactNode`, which the emitter writes unqualified as every catalog component's return
// type, is a fourth external reference with NO import to hoist — the name reaches the emitter
// through `@opentui/react`'s `jsx-namespace.d.ts` (`type Element = React.ReactNode`), whose own
// `import type * as React from "react"` does not resolve in this project either (`@types/react`
// is not installed; `react@19` ships no types). It is left exactly as emitted. Rewriting it
// would mean inventing a return type the compiler never produced.
//
// The emit itself runs the REAL compiler as a subprocess: `typescript@7`'s npm package exposes
// only `typescript/unstable/{sync,async,fs,ast}` — there is no classic `ts.createProgram` JS
// API — while the spawnable `tsc` executable lives in the platform package
// (`@typescript/typescript-<platform>-<arch>/lib/tsc.exe`), resolved here through module
// resolution rather than a hand-built path. The temp tsconfig `extends` the repo's real
// `tsconfig.json` so the emit mirrors the project's own compiler settings (`strict`, `jsx`,
// `jsxImportSource`, `verbatimModuleSyntax`, the path aliases) instead of a hand-copied subset;
// only the emit flags, `rootDir`/`outDir`, the file list and `typeRoots` are overridden
// (`typeRoots` because `types: ["bun"]` resolves relative to the config file's own directory,
// which is the temp dir, not the repo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as errore from "errore";

/** Any failure of the emit pipeline: a missing compiler, a non-zero `tsc`, or an unparsable emit. */
export class RuntimeDtsEmitError extends errore.createTaggedError({
  name: "RuntimeDtsEmitError",
  message: "could not emit the ambient @termcraft/runtime declaration: $reason",
}) {}

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, "src/runtime");
const ENTRY = path.join(RUNTIME_DIR, "index.ts");
const OUT_FILE = path.join(REPO_ROOT, "src/runtime/generated/runtime-dts.ts");
const MODULE_SPECIFIER = "@termcraft/runtime";
/** The emitted chunk that owns the JSX factory re-exports, and the upstream scope it re-exports. */
const JSX_CHUNK = "model/jsx.d.ts";
const UPSTREAM_JSX_SCOPE = "@opentui/react/";

/** Forward slashes everywhere: a tsconfig path is JSON, where a Windows backslash is an escape. */
function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Locate the spawnable Go compiler through module resolution over the platform package,
 * never a hand-built `node_modules/...` path (the package name is platform + arch specific,
 * and only the host's own is installed).
 */
function resolveTscExe(): string | RuntimeDtsEmitError {
  const pkg = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
  const manifest = errore.try({
    try: () => Bun.resolveSync(pkg, REPO_ROOT),
    catch: (cause) => new RuntimeDtsEmitError({ reason: `cannot resolve ${pkg}`, cause }),
  });
  if (manifest instanceof Error) return manifest;

  const exe = path.join(
    path.dirname(manifest),
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  );
  if (!fs.existsSync(exe)) return new RuntimeDtsEmitError({ reason: `${exe} does not exist` });
  return exe;
}

/**
 * The temp project that drives the emit. `extends` the repo tsconfig so every real compiler
 * setting (including `paths`) applies; `include: []` + `files` narrow the program to the
 * runtime facade's own graph.
 */
function emitTsconfig(outDir: string): string {
  return JSON.stringify(
    {
      extends: posix(path.join(REPO_ROOT, "tsconfig.json")),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: posix(outDir),
        rootDir: posix(RUNTIME_DIR),
        typeRoots: [posix(path.join(REPO_ROOT, "node_modules/@types"))],
      },
      include: [],
      files: [posix(ENTRY)],
    },
    null,
    2,
  );
}

/** Run `tsc -p <config>`; a non-zero exit carries the compiler's own output as the reason. */
function runEmit(tscExe: string, configPath: string): RuntimeDtsEmitError | null {
  const proc = Bun.spawnSync([tscExe, "-p", configPath], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode === 0) return null;
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return new RuntimeDtsEmitError({
    reason: `tsc exited ${String(proc.exitCode)}: ${output}`,
  });
}

/** Every emitted `.d.ts` under `dir`, as repo-relative-to-`dir` posix paths, sorted. */
function collectEmitted(dir: string): string[] {
  const walk = (current: string): string[] =>
    fs
      .readdirSync(current, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk(path.join(current, entry.name))
          : [posix(path.relative(dir, path.join(current, entry.name)))],
      );
  return walk(dir).sort();
}

/** A hoisted external import: which value names and which type-only names one specifier supplies. */
interface HoistedImport {
  readonly values: Set<string>;
  readonly types: Set<string>;
}

/** Split a `{ a, b, }` clause into its names, tolerating the emitter's trailing comma. */
function parseNamedBindings(clause: string): string[] {
  return clause
    .slice(1, -1)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const IMPORT_RE = /^import\s+(type\s+)?(\{[^}]*\})\s+from\s+"([^"]+)";$/;
const EXPORT_FROM_RE = /^export\s+(type\s+)?(\{[^}]*\})\s+from\s+"([^"]+)";$/;
const DECLARED_NAME_RE =
  /^(?:declare\s+(?:function|const|let|var|class|namespace|enum)|interface|type)\s+([A-Za-z_$][\w$]*)/;

function isRelative(specifier: string): boolean {
  return specifier.startsWith(".");
}

/** Record one external specifier's names into the hoisted-import table. */
function hoist(
  into: Map<string, HoistedImport>,
  specifier: string,
  typeOnly: boolean,
  names: readonly string[],
): void {
  const entry = into.get(specifier) ?? { values: new Set<string>(), types: new Set<string>() };
  for (const name of names) (typeOnly ? entry.types : entry.values).add(name);
  into.set(specifier, entry);
}

/** One flattened chunk: the block-local declaration text of a single emitted `.d.ts`. */
interface Chunk {
  readonly file: string;
  readonly body: string;
  readonly declared: readonly string[];
}

/**
 * Rewrite one emitted chunk into block-local declarations: drop the relative wiring (every
 * referenced name lands in the same ambient block), hoist the external imports, and strip the
 * `export` modifier so `index.d.ts`'s re-export list stays the single source of the public
 * surface. Any `export` form this does not recognise is a hard failure — silently dropping a
 * declaration would ship a declaration that lies about the runtime.
 */
function flattenChunk(
  file: string,
  text: string,
  imports: Map<string, HoistedImport>,
): Chunk | RuntimeDtsEmitError {
  const out: string[] = [];
  const declared: string[] = [];

  for (const line of text.split("\n")) {
    const trimmedEnd = line.replace(/\r$/, "");
    if (trimmedEnd === "export {};") continue;

    const importMatch = IMPORT_RE.exec(trimmedEnd);
    if (importMatch !== null) {
      const [, typeOnly, clause, specifier] = importMatch;
      if (specifier === undefined || clause === undefined) continue;
      if (!isRelative(specifier))
        hoist(imports, specifier, typeOnly !== undefined, parseNamedBindings(clause));
      continue;
    }

    const exportFromMatch = EXPORT_FROM_RE.exec(trimmedEnd);
    if (exportFromMatch !== null) {
      const [, typeOnly, clause, specifier] = exportFromMatch;
      if (specifier === undefined || clause === undefined) continue;
      // A chunk's `export … from` is a re-export of an EXTERNAL name (a relative one is
      // internal wiring the flattening dissolves). It becomes a plain hoisted import; whether
      // the name reaches the facade's surface is decided by `index.d.ts` alone.
      if (!isRelative(specifier))
        hoist(imports, specifier, typeOnly !== undefined, parseNamedBindings(clause));
      continue;
    }

    if (trimmedEnd.startsWith("export ")) {
      const local = trimmedEnd.slice("export ".length);
      const nameMatch = DECLARED_NAME_RE.exec(local);
      if (nameMatch === null)
        return new RuntimeDtsEmitError({
          reason: `unrecognised exported declaration in ${file}: ${trimmedEnd}`,
        });
      if (nameMatch[1] !== undefined) declared.push(nameMatch[1]);
      out.push(local);
      continue;
    }

    const nameMatch = DECLARED_NAME_RE.exec(trimmedEnd);
    if (nameMatch?.[1] !== undefined) declared.push(nameMatch[1]);
    out.push(trimmedEnd);
  }

  return { file, body: out.join("\n").trim(), declared };
}

/** Replay `index.d.ts`'s re-export list as bare `export { … }` statements over the flat block. */
function flattenIndex(text: string): string[] | RuntimeDtsEmitError {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmedEnd = line.replace(/\r$/, "");
    if (trimmedEnd.trim().length === 0) continue;

    const match = EXPORT_FROM_RE.exec(trimmedEnd);
    if (match === null)
      return new RuntimeDtsEmitError({
        reason: `unrecognised statement in the emitted index.d.ts: ${trimmedEnd}`,
      });

    const [, typeOnly, clause, specifier] = match;
    if (clause === undefined || specifier === undefined) continue;
    if (!isRelative(specifier))
      return new RuntimeDtsEmitError({
        reason: `index.ts re-exports the external "${specifier}" directly; the flattening only handles relative re-exports`,
      });

    const names = parseNamedBindings(clause).join(", ");
    out.push(`export ${typeOnly !== undefined ? "type " : ""}{ ${names} };`);
  }
  return out;
}

/**
 * Derive the facade's own JSX-runtime sub-modules from the REAL emitted `model/jsx.d.ts`.
 *
 * WHY they exist at all, and why this is not an invented specifier. Verified empirically (see
 * this file's header, point 3, for the harness): with the Gate's `jsx: "react-jsx"` and no
 * `jsxImportSource`, EVERY JSX page fails the hermetic check with `TS2875 This JSX tag requires
 * the module path 'react/jsx-runtime' to exist` — the default factory module is `react`, which
 * does not resolve from `os.tmpdir()` (and `@types/react` is not installed anywhere in this
 * project). A declaration that rejects every authored design page is worse than none, so the
 * Gate's tsconfig now sets `jsxImportSource: "@termcraft/runtime"` and this declaration supplies
 * the two sub-modules TypeScript then looks for.
 *
 * Their names and bodies are both SOURCED, not chosen: `src/runtime/model/jsx.ts`'s own NOTE
 * states the intended wiring is "`jsxImportSource: "@termcraft/runtime"` … a package `exports`
 * map for `@termcraft/runtime/jsx-runtime`", and each block's body is the emitted re-export line
 * verbatim. The sub-path mirrors the upstream one it re-exports (`@opentui/react/jsx-runtime` →
 * `@termcraft/runtime/jsx-runtime`), so the mapping is mechanical rather than editorial.
 */
function buildJsxSubmodules(text: string): string[] | RuntimeDtsEmitError {
  const blocks: string[] = [];
  for (const line of text.split("\n")) {
    const statement = line.replace(/\r$/, "");
    if (statement.trim().length === 0) continue;

    const match = EXPORT_FROM_RE.exec(statement);
    if (match === null)
      return new RuntimeDtsEmitError({
        reason: `unrecognised statement in the emitted ${JSX_CHUNK}: ${statement}`,
      });

    const specifier = match[3];
    if (specifier === undefined || !specifier.startsWith(UPSTREAM_JSX_SCOPE))
      return new RuntimeDtsEmitError({
        reason: `${JSX_CHUNK} re-exports "${String(specifier)}", which is outside "${UPSTREAM_JSX_SCOPE}"; the facade sub-path mapping only covers that scope`,
      });

    const sub = specifier.slice(UPSTREAM_JSX_SCOPE.length);
    blocks.push(`declare module "${MODULE_SPECIFIER}/${sub}" {\n  ${statement}\n}\n`);
  }
  return blocks.sort();
}

/** Render the hoisted imports, sorted by specifier then by name, so the emit is byte-stable. */
function renderImports(imports: Map<string, HoistedImport>): string[] {
  const lines: string[] = [];
  for (const specifier of [...imports.keys()].sort()) {
    const entry = imports.get(specifier);
    if (entry === undefined) continue;
    const values = [...entry.values].sort();
    // A name imported both ways is a value import; `import type` on top would redeclare it.
    const types = [...entry.types].filter((name) => !entry.values.has(name)).sort();
    if (values.length > 0) lines.push(`import { ${values.join(", ")} } from "${specifier}";`);
    if (types.length > 0) lines.push(`import type { ${types.join(", ")} } from "${specifier}";`);
  }
  return lines;
}

/** Indent one flattened block by two spaces, leaving blank lines blank. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `  ${line}`))
    .join("\n");
}

/** Assemble the whole `declare module "@termcraft/runtime" { … }` text from the emitted chunks. */
function buildDeclaration(outDir: string): string | RuntimeDtsEmitError {
  const emitted = collectEmitted(outDir);
  if (!emitted.includes("index.d.ts"))
    return new RuntimeDtsEmitError({ reason: `no index.d.ts under ${outDir}` });
  if (!emitted.includes(JSX_CHUNK))
    return new RuntimeDtsEmitError({ reason: `no ${JSX_CHUNK} under ${outDir}` });

  const imports = new Map<string, HoistedImport>();
  const chunks: Chunk[] = [];
  const declaredBy = new Map<string, string>();

  for (const file of emitted.filter((name) => name !== "index.d.ts")) {
    const chunk = flattenChunk(file, fs.readFileSync(path.join(outDir, file), "utf8"), imports);
    if (chunk instanceof Error) return chunk;
    for (const name of chunk.declared) {
      const owner = declaredBy.get(name);
      if (owner !== undefined)
        return new RuntimeDtsEmitError({
          reason: `"${name}" is declared by both ${owner} and ${file}; flattening them into one ambient module would redeclare it`,
        });
      declaredBy.set(name, file);
    }
    if (chunk.body.length > 0) chunks.push(chunk);
  }

  const exports = flattenIndex(fs.readFileSync(path.join(outDir, "index.d.ts"), "utf8"));
  if (exports instanceof Error) return exports;

  const importLines = renderImports(imports);
  for (const [specifier, entry] of imports) {
    for (const name of [...entry.values, ...entry.types]) {
      const owner = declaredBy.get(name);
      if (owner !== undefined)
        return new RuntimeDtsEmitError({
          reason: `"${name}" is both imported from "${specifier}" and declared by ${owner}`,
        });
    }
  }

  const jsxSubmodules = buildJsxSubmodules(fs.readFileSync(path.join(outDir, JSX_CHUNK), "utf8"));
  if (jsxSubmodules instanceof Error) return jsxSubmodules;

  const sections = [
    importLines.join("\n"),
    ...chunks.map(
      (chunk) => `// ── src/runtime/${chunk.file.replace(/\.d\.ts$/, "")}\n${chunk.body}`,
    ),
    `// ── the facade's public surface (src/runtime/index.ts)\n${exports.join("\n")}`,
  ].filter((section) => section.length > 0);

  const facade = `declare module "${MODULE_SPECIFIER}" {\n${indent(sections.join("\n\n"))}\n}\n`;
  return [facade, ...jsxSubmodules].join("\n");
}

/** Escape the declaration text for a template literal so the constant's value is byte-exact. */
function asTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** The committed module: a single string constant, importing NOTHING — `runtime` is a leaf. */
function renderModule(declaration: string): string {
  return [
    "// GENERATED by scripts/gen-runtime-dts.ts — do not hand-edit. Regenerate with",
    "// `bun run scripts/gen-runtime-dts.ts` after any change to src/runtime's public surface;",
    "// `src/runtime/generated/runtime-dts.test.ts` fails the gates when this drifts from a fresh",
    "// emit. See the generator's header for why the declaration is flattened and why its external",
    "// specifiers (@reatom/core, @reatom/react, @opentui/react/jsx-runtime) stay unresolved under",
    "// the Gate's hermetic `skipLibCheck` check.",
    "//",
    "// This module imports NOTHING on purpose: `runtime` is a leaf in the module DAG",
    "// (docs/architecture/code-structure.md), and a generated string constant keeps it one.",
    "",
    "/**",
    " * The ambient `@termcraft/runtime` declaration, emitted from the real `src/runtime/index.ts`.",
    " * Consumed twice: as the Gate's `runtimeDts` (`src/gate/model/type-check.ts`) and as the",
    " * agent prompt library's runtime API reference (phase-8 design §WP-2, §WP-3).",
    " */",
    `export const RUNTIME_DTS = \`${asTemplateLiteral(declaration)}\`;`,
    "",
  ].join("\n");
}

/** Emit the declaration into a throwaway temp project and return its text. */
function generate(): string | RuntimeDtsEmitError {
  const tscExe = resolveTscExe();
  if (tscExe instanceof Error) return tscExe;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-runtime-dts-"));
  try {
    const outDir = path.join(tempDir, "out");
    const configPath = path.join(tempDir, "emit.tsconfig.json");
    fs.writeFileSync(configPath, emitTsconfig(outDir));

    const failure = runEmit(tscExe, configPath);
    if (failure !== null) return failure;

    return buildDeclaration(outDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(): RuntimeDtsEmitError | null {
  const declaration = generate();
  if (declaration instanceof Error) return declaration;

  // `--stdout` prints the DECLARATION TEXT — the exact value of `RUNTIME_DTS`, not the module
  // that wraps it — so the drift test can diff a fresh emit against the committed constant
  // without writing anything into the working tree.
  if (process.argv.includes("--stdout")) {
    process.stdout.write(declaration);
    return null;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, renderModule(declaration));
  console.log(`wrote ${OUT_FILE} (${String(declaration.length)} chars of declaration)`);
  return null;
}

const error = main();
if (error !== null) {
  console.error(error.message);
  process.exit(1);
}

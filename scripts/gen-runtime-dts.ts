// Regenerates the ambient `@termcraft/runtime` declaration, in TWO artifacts from ONE emit
// (phase-8 design §WP-2, §WP-3; split by spec WP-4 on 2026-08-09):
//
//   src/runtime/generated/runtime-dts.ts        the GATE copy — `RUNTIME_DTS`, the string the
//                                               hermetic type check (`src/gate/model/type-check.ts`)
//                                               hands the Go compiler. Carries the real installed
//                                               `@reatom/core` declarations inline; see
//                                               `buildReatomCoreBlock`.
//   src/runtime/generated/runtime.generated.d.ts  the PROMPT copy — the same facade WITHOUT that
//                                               block, staged into the agent's turn workspace by
//                                               path. A prompt attachment, so its size is a
//                                               first-class constraint.
//
// Run `bun run scripts/gen-runtime-dts.ts` after any change to `src/runtime`'s public surface.
// `--stdout` prints the PROMPT copy's text instead of writing the files, and `--stdout=gate`
// prints the gate copy's — which is how `src/runtime/generated/runtime-dts.test.ts` proves each
// committed artifact has not drifted from its own fresh emit. The output is COMMITTED rather than
// generated at install time: it is read by humans reviewing what the agent is told, and the drift
// tests are the staleness guard. (Phase 8 deleted the one generated artifact this repository used
// to keep gitignored and rebuild from a `postinstall` hook — that shape broke a fresh clone,
// because the tree could not even be imported until the hook had run.)
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
//     block: every chunk's declarations are re-emitted verbatim with their `export` AND
//     `declare` modifiers stripped (so they become block-local — a bare `declare function …`
//     left in place after flattening is TS1038, "A 'declare' modifier cannot be used in an
//     already ambient context", since the surrounding `declare module` block is already
//     ambient; `stripDeclareModifier` below removes it the same way the `export ` strip does,
//     for the same reason), and `index.d.ts`'s own re-export list is replayed as bare
//     `export { … }` / `export type { … }` statements. That reproduces the facade's public
//     surface EXACTLY — `activeTokens`, which `model/tokens.ts` exports but `index.ts` does
//     not, stays internal, as it must.
//
//  2. THE EXTERNAL TYPE SURFACE STAYS BY REFERENCE, NOT INLINED. ⚠ AMENDED 2026-08-09 for
//     `@reatom/core` ONLY — see `buildReatomCoreBlock` below, which states what changed and why
//     this is not a re-litigation. The rest of point 2, and above all its refusal to hand-write
//     stand-ins, stand unchanged. The original text follows:
//     The emitted declarations
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
//     ⚠ RETRACTED 2026-08-09: this claim was FALSE for `@reatom/core`, and the verification
//     below is exactly the half-check it warns others against. What it verified — a valid page
//     passes, a bad PROP still fails — was true and stayed true; what it never thought to check
//     is that the `any`-degraded `atom` MANUFACTURED four fatal `TS7006`s against correctly-typed
//     pages, and that the check could not detect a misspelled field on atom state at all.
//     `buildReatomCoreBlock` fixes it for `@reatom/core`; the claim still holds, unamended, for
//     `@reatom/react` and `@opentui/react/jsx-*` — with one measured exception recorded there
//     (lowercase raw JSX elements are a fatal TS7026). The original text follows verbatim, since
//     its reasoning is what the retraction is about:
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
const DTS_OUT_FILE = path.join(REPO_ROOT, "src/runtime/generated/runtime.generated.d.ts");
const MODULE_SPECIFIER = "@termcraft/runtime";
const REATOM_CORE_SPECIFIER = "@reatom/core";
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

/**
 * Strip a leading `declare ` modifier from one declaration's first line. TypeScript's
 * per-file declaration emit always places `declare` — when present — as the very first token
 * of a top-level VALUE declaration's first line (`function`/`const`/`let`/`var`/`class`/
 * `namespace`/`enum`; a pure `interface`/`type` never carries it, since those have no runtime
 * existence to declare ambient). An exported value gets `export declare …`; a module-private
 * helper referenced only by another declaration's type (`ALIGN`/`JUSTIFY` backing `BoxProps`)
 * gets a bare `declare …` with no `export`. Both forms describe the CHUNK's own module
 * boundary — "this value exists outside this file" — which flattening dissolves: every chunk
 * lands inside one already-ambient `declare module "@termcraft/runtime"` block, where a
 * second, nested `declare` is invalid (TS1038, "A 'declare' modifier cannot be used in an
 * already ambient context"). This mirrors the `export ` strip below for the same reason.
 * Continuation lines of a multi-line declaration (an object-type literal spanning several
 * lines, e.g. `ALIGN`'s body) never repeat the leading token, so a single-line, first-token-only
 * check covers the whole statement without touching its body.
 */
function stripDeclareModifier(line: string): string {
  return line.startsWith("declare ") ? line.slice("declare ".length) : line;
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
      out.push(stripDeclareModifier(local));
      continue;
    }

    const nameMatch = DECLARED_NAME_RE.exec(trimmedEnd);
    if (nameMatch?.[1] !== undefined) declared.push(nameMatch[1]);
    out.push(stripDeclareModifier(trimmedEnd));
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

/**
 * Locate the installed `@reatom/core`'s own declaration through MODULE RESOLUTION, never a
 * hand-built `node_modules/...` path — the same rule {@link resolveTscExe} follows, and for a
 * sharper reason here: what gets inlined must provably be the package this repository actually
 * depends on, and a literal path is a claim about a layout rather than a resolution of one.
 */
function resolveReatomCoreDts(): string | RuntimeDtsEmitError {
  const pkg = `${REATOM_CORE_SPECIFIER}/package.json`;
  const manifest = errore.try({
    try: () => Bun.resolveSync(pkg, REPO_ROOT),
    catch: (cause) => new RuntimeDtsEmitError({ reason: `cannot resolve ${pkg}`, cause }),
  });
  if (manifest instanceof Error) return manifest;

  const dts = path.join(path.dirname(manifest), "dist", "index.d.ts");
  if (!fs.existsSync(dts)) return new RuntimeDtsEmitError({ reason: `${dts} does not exist` });
  return dts;
}

/**
 * Each line's text with block and line comments removed, tracking `/* … *\/` across lines.
 *
 * WHY A STRIPPER AND NOT AN ANCHORED REGEX (review finding, 2026-08-09). The first version of
 * {@link checkInlinability} tested `/^import\s/` against the raw line, and MISSED the one real
 * top-level import the installed package has, because its bundler glued the statement onto the
 * tail of the JSDoc block that precedes it:
 *
 *     *\/import { StandardSchemaV1 } from "@standard-schema/spec";
 *
 * A guard that only sees column 0 would keep missing that shape — including for a RELATIVE
 * import, which is the case the guard exists to catch. Column position is not the property being
 * tested; "is this line's CODE an import statement" is.
 *
 * String literals are deliberately not tracked. The result is used only to ask whether a line's
 * code STARTS with an import/export statement, and an unclosed-quote misread can only truncate a
 * line early — i.e. it can make the guard miss, never fire spuriously — and a leading statement
 * cannot sit after a string on its own line anyway. `/// <reference>` is tested against the RAW
 * line by its caller, since this function correctly erases it as the comment it is.
 */
function stripComments(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    let code = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end === -1) break;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const block = line.indexOf("/*", i);
      const lineComment = line.indexOf("//", i);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        code += line.slice(i, lineComment);
        i = line.length;
        break;
      }
      if (block === -1) {
        code += line.slice(i);
        break;
      }
      code += line.slice(i, block);
      inBlock = true;
      i = block + 2;
    }
    out.push(code);
  }
  return out;
}

/** The module specifier a single import/export statement names, if it names one. */
function specifierOf(statement: string): string | null {
  return /(?:from\s*|^\s*import\s*)["']([^"']+)["']/.exec(statement)?.[1] ?? null;
}

/**
 * Decide whether a package's own declaration can be wrapped in an ambient module block without
 * lying about the runtime, and return the bare specifiers it will still import unresolved.
 *
 * THE POINT IS TO FAIL AT GENERATION TIME, because the Gate cannot fail later: the block is
 * served as a `.d.ts` under `skipLibCheck: true`, so anything wrong inside it raises NO
 * diagnostic and simply degrades to `any`. Three shapes are refused, and each for a stated
 * reason rather than by analogy:
 *
 *  - A RELATIVE import or re-export. TypeScript rejects it outright inside an ambient module
 *    declaration (TS2439), and even where it did not, the path is relative to a `node_modules`
 *    layout the Gate never sees — so every name it binds would silently become `any`.
 *  - `export *`. The flattening replays a curated export list; a star re-export out of an
 *    unresolved module contributes nothing and silently drops whatever it was meant to add.
 *  - `/// <reference …>`. Only honoured at the top of a FILE, before any statement. Wrapped
 *    inside a block it degrades to an ordinary comment, so the dependency it declares vanishes
 *    without a word.
 *
 * A NON-RELATIVE import is NOT refused, and that is a decision rather than an oversight. It is
 * legal inside an ambient module declaration, and its names degrade to `any` in exactly the way
 * the facade's own hoisted specifiers already do — the bounded, documented status quo this file's
 * header describes, not a new failure mode. Refusing it would mean refusing to inline the package
 * that is installed today. The caller reports the list instead, so the degradation stays visible.
 */
function checkInlinability(
  dtsPath: string,
  lines: readonly string[],
): string[] | RuntimeDtsEmitError {
  const code = stripComments(lines);
  const specifiers = new Set<string>();

  for (const [index, line] of code.entries()) {
    // A triple-slash directive IS a comment, so `stripComments` erased it — test the raw line.
    if (/^\s*\/\/\/\s*<reference/.test(lines[index] ?? ""))
      return new RuntimeDtsEmitError({
        reason: `${dtsPath}:${String(index + 1)} is a /// <reference>, which is only honoured at the top of a file and silently becomes a plain comment once wrapped in an ambient module declaration: ${(lines[index] ?? "").trim()}`,
      });

    if (/^\s*export\s+\*/.test(line))
      return new RuntimeDtsEmitError({
        reason: `${dtsPath}:${String(index + 1)} is an "export *", which re-exports nothing once the module it names is unresolved: ${line.trim()}`,
      });

    // `import\s` and not `import\b`: `import("…")` is a TYPE QUERY, legal inside an ambient
    // block, and must not be mistaken for an import statement. The export arm requires `from`
    // to sit immediately before a QUOTE, so the package's own 350-name `export { … };` surface
    // line — which can legitimately contain an exported binding called `from` — is not read as
    // a re-export.
    if (!/^\s*(?:import\s|export\b[^;]*\bfrom\s*["'])/.test(line)) continue;

    const specifier = specifierOf(line);
    if (specifier === null)
      return new RuntimeDtsEmitError({
        reason: `${dtsPath}:${String(index + 1)} is an import/export statement whose module specifier could not be read, so whether it survives the inline cannot be decided: ${line.trim()}`,
      });

    if (isRelative(specifier))
      return new RuntimeDtsEmitError({
        reason: `${dtsPath}:${String(index + 1)} imports the RELATIVE "${specifier}", which is invalid inside an ambient module declaration (TS2439) and unresolvable from the Gate's synthetic cwd either way: ${line.trim()}`,
      });

    specifiers.add(specifier);
  }

  return [...specifiers].sort();
}

/**
 * Inline the REAL `@reatom/core` declarations into the GATE copy (defect fix, 2026-08-09,
 * spec WP-4). Verified end-to-end before it was written: `docs/spikes/10-reatom-dts-inline`.
 *
 * WHY THIS REVERSES POINT 2 OF THIS FILE'S HEADER, AND WHY THAT IS NOT REOPENING IT. Point 2
 * rejected inlining on measured size — ~296 KB — because "this same string is the agent's runtime
 * reference". That premise is what changed: the prompt copy and the gate copy are now separate
 * artifacts with separate audiences, so the size objection applies to the prompt copy only, and
 * the prompt copy does not get this block. Point 3's "the unresolved specifiers are harmless to
 * the Gate" is what turned out to be false, and the mechanism is precise: `skipLibCheck` makes
 * the unresolved `@reatom/core` names `any`, a type argument on an `any` callee is ignored, and
 * `.map()` on `any` has NO contextual signature — which `noImplicitAny` reports as TS7006. So
 * the hermetic check MANUFACTURED four fatal diagnostics against correctly-typed pages, and no
 * annotation the author writes can really fix them, because the code is unchecked either way.
 * The spike measured the reverse direction too: before the inline the Gate could not detect a
 * misspelled field on atom state AT ALL (it answered `TS7006`, never naming the field); after
 * it, that page yields `TS2339`. The check got stronger, not merely quieter.
 *
 * SCOPE IS `@reatom/core` ALONE, and that is the whole measured origin. `@reatom/react`'s
 * `reatomComponent` stays by reference: its declaration imports `React`, `ChangeEvent` from
 * `react` and `JSX` from `react/jsx-runtime`, and `@types/react` is not installed
 * (`react@19` ships none), so inlining it would mean inventing React's types — which the
 * honest-values rule forbids outright. `@opentui/react`'s JSX factories and the unqualified
 * `React.ReactNode` stay by reference for the same reason, and stay documented as unchecked.
 * One measured consequence of that, pinned by `gate/model/type-check.test.ts`'s S1 fixture:
 * every LOWERCASE raw JSX element is a fatal `TS7026`, because `JSX.IntrinsicElements` lives in
 * the unresolved `@opentui/react/jsx-runtime` namespace. That defect predates this function and
 * is not fixed by it.
 *
 * WHAT IS INLINED IS EMITTED, NEVER WRITTEN. The source is the installed package's own
 * `dist/index.d.ts`, resolved through module resolution and transformed only by the same
 * declare-strip the facade flattening already applies (see {@link stripDeclareModifier}) plus the
 * two-space indent every block in this file gets. Note what that does to the package's single
 * `declare global { … }` block: it becomes `global { … }`, which is the correct form inside an
 * already-ambient block — the spike proved it by diffing the diagnostics against a variant with
 * that block deleted, and they are identical, so the block ships. `runtime-dts.test.ts` re-derives
 * this transformation from the package and asserts the committed block line-for-line, which is
 * what keeps "emitted, never written" checkable instead of merely claimed.
 *
 * THE BLOCK CARRIES ONE IMPORT OF ITS OWN, AND IT IS KEPT RATHER THAN STRIPPED (review finding,
 * 2026-08-09). The package's declaration opens with `import { StandardSchemaV1 } from
 * "@standard-schema/spec"` — glued to the tail of the preceding JSDoc close by its bundler, which
 * is how the first version of {@link checkInlinability} failed to see it. It rides into the
 * ambient block, where it is legal, and where nothing resolves it — so `StandardSchemaV1` is
 * `any` there. Keeping it is the honest option on both counts: TWELVE declarations in the package
 * REFERENCE that binding (`WithPersistOptions.schema`, the field/form validation types, the
 * routing `params`/`search` codecs), so deleting the import would leave them naming a vanished
 * type; and deleting it would be an edit to the package's own text — authoring, the one thing
 * this block is constructed to avoid. The cost is nil in practice, and that is CHECKED rather
 * than asserted: the facade re-exports only `atom`/`computed`/`action`/`wrap`/`with*` and the
 * types `Atom`/`Action`/`Computed`/`AtomLike`/`Ext` (`src/runtime/model/reatom.ts`) — no
 * persistence, forms or routing — and the PROMPT copy, which is the facade's own emitted text,
 * contains ZERO occurrences of `StandardSchemaV1`. `src/gate/model/type-check.ts`'s
 * per-specifier note carries the same fact from the Gate's side.
 *
 * It is COMMITTED, so nothing at install or run time depends on a `node_modules` layout — which
 * is precisely the binding point 3 refused, and this does not reintroduce it.
 *
 * THE COST IS REAL AND MEASURED, not waved past: the gate copy grows from ~30 KB to ~338 KB, and
 * the compiler parses that on every whole-tree check. Spike 10, median of five runs over a
 * five-page tree with a shared module: 48 ms → 61 ms. The per-check compiler-API construction at
 * `src/gate/model/type-check.ts` stays a ledger row, not a consequence of this.
 */
function buildReatomCoreBlock(): string | RuntimeDtsEmitError {
  const dtsPath = resolveReatomCoreDts();
  if (dtsPath instanceof Error) return dtsPath;

  const raw = errore.try({
    try: () => fs.readFileSync(dtsPath, "utf8"),
    catch: (cause) => new RuntimeDtsEmitError({ reason: `cannot read ${dtsPath}`, cause }),
  });
  if (raw instanceof Error) return raw;

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const survivable = checkInlinability(dtsPath, lines);
  if (survivable instanceof Error) return survivable;

  // Every bare specifier the inlined block still imports, on stderr (never stdout, which carries
  // the artifact under `--stdout`) on every run. These degrade to `any` exactly like the facade's
  // own hoisted specifiers, which is bounded and documented — but it is bounded only as long as
  // somebody can SEE the list, so the generator prints it rather than leaving a reader to grep.
  if (survivable.length > 0)
    console.warn(
      `gen-runtime-dts: the inlined ${REATOM_CORE_SPECIFIER} block imports ` +
        `${survivable.join(", ")} by specifier; nothing resolves those under the Gate's hermetic ` +
        "check, so their names are `any` there. See src/gate/model/type-check.ts's per-specifier " +
        "note, and widen it if this list changes.",
    );

  const body = lines.map(stripDeclareModifier).join("\n");
  return `declare module "${REATOM_CORE_SPECIFIER}" {\n${indent(body)}\n}\n`;
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
    "// emit. See the generator's header for why the declaration is flattened.",
    "//",
    "// This is the GATE copy: the facade declaration PLUS the real installed `@reatom/core`",
    "// declarations, inlined as an ambient module so `atom`/`computed`/`action`/`wrap` and the",
    "// types they return resolve under the Gate's hermetic check instead of degrading to `any`",
    "// (`buildReatomCoreBlock`). `@reatom/react` and `@opentui/react/jsx-*` deliberately stay",
    "// unresolved — `@types/react` is not installed anywhere in this project, so inlining them",
    "// would mean inventing React's types. The PROMPT copy, `runtime.generated.d.ts`, is the same",
    "// facade WITHOUT the inlined block: it is a prompt attachment, where size is the constraint.",
    "//",
    "// This module imports NOTHING on purpose: `runtime` is a leaf in the module DAG",
    "// (docs/architecture/code-structure.md), and a generated string constant keeps it one.",
    "",
    "/**",
    " * The ambient `@termcraft/runtime` declaration, emitted from the real `src/runtime/index.ts`,",
    " * plus the inlined `@reatom/core` declarations. Consumed by the Gate's hermetic type check",
    " * alone (`src/gate/model/type-check.ts`, phase-8 design §WP-2); the agent prompt library reads",
    " * the smaller sibling file `runtime.generated.d.ts` instead (§WP-3).",
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

/**
 * Which artifact `--stdout` should print. BARE `--stdout` STILL MEANS THE PROMPT COPY — the
 * meaning it had before Task 7 split one artifact into two — so no existing invocation changed
 * meaning silently when the second target appeared. `runtime-dts.test.ts` asserts that default
 * rather than leaving it to a reader of this file.
 */
type StdoutTarget = "prompt" | "gate";

const STDOUT_RE = /^--stdout(?:=(.*))?$/;

/** `null` = no `--stdout` flag at all (write the files instead). */
function parseStdoutTarget(argv: readonly string[]): StdoutTarget | null | RuntimeDtsEmitError {
  const flag = argv.map((arg) => STDOUT_RE.exec(arg)).find((match) => match !== null);
  if (flag === undefined) return null;
  const selector = flag[1];
  if (selector === undefined || selector === "prompt") return "prompt";
  if (selector === "gate") return "gate";
  return new RuntimeDtsEmitError({
    reason: `unknown --stdout target "${selector}"; expected "prompt" or "gate"`,
  });
}

function main(): RuntimeDtsEmitError | null {
  const target = parseStdoutTarget(process.argv);
  if (target instanceof Error) return target;

  // ONE emit, TWO artifacts. Emitting twice would let the copies disagree; deriving both from
  // this single `declaration` makes that impossible by construction.
  const declaration = generate();
  if (declaration instanceof Error) return declaration;

  const reatomBlock = buildReatomCoreBlock();
  if (reatomBlock instanceof Error) return reatomBlock;
  const gateDeclaration = `${declaration}\n${reatomBlock}`;

  // `--stdout` prints DECLARATION TEXT — not the module that wraps the gate copy — so the drift
  // tests can diff a fresh emit of either artifact against the committed one without writing
  // anything into the working tree.
  if (target !== null) {
    process.stdout.write(target === "gate" ? gateDeclaration : declaration);
    return null;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  // The GATE copy. `RUNTIME_DTS` serves the hermetic type check's in-process `runtimeDts: string`
  // parameter and nothing else, so it can afford the ~308 KB of inlined `@reatom/core`
  // declarations that make a page's atom reads actually typed.
  fs.writeFileSync(OUT_FILE, renderModule(gateDeclaration));
  // The PROMPT copy: the same facade declaration as an ordinary `.d.ts` file rather than a JS
  // string constant, and WITHOUT the inlined block. It serves the agent-prompt library (phase-8
  // WP-3, `agent/prompt/model/runtime-docs.ts`), which stages a real, human/agent-readable
  // declaration file into the turn workspace BY PATH — "under npm these are ordinary files inside
  // the installed package" (phase-8 design §WP-3). It is a PROMPT ATTACHMENT, so its size is a
  // first-class constraint and the inlined block would be a tenfold regression against no benefit
  // at all: the agent reads this to learn the facade's surface, not `@reatom/core`'s internals.
  // Both artifacts come from the SAME `declaration` in this one run, so the facade text they
  // share cannot drift; `runtime-dts.test.ts` pins that the gate copy is this file plus exactly
  // one block, and pins this file's size ceiling.
  fs.writeFileSync(DTS_OUT_FILE, declaration);
  console.log(`wrote ${OUT_FILE} (${String(gateDeclaration.length)} chars, gate copy)`);
  console.log(`wrote ${DTS_OUT_FILE} (${String(declaration.length)} chars, prompt copy)`);
  return null;
}

const error = main();
if (error !== null) {
  console.error(error.message);
  process.exit(1);
}

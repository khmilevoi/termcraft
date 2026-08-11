import os from "node:os";
import path from "node:path";

import * as errore from "errore";
import { API } from "typescript/unstable/sync";
import type { Diagnostic } from "typescript/unstable/sync";

import { isCodeFile } from "entities/design-tree";
import { log } from "infrastructure/debug-log";

import type { GateError } from "../types";
import { lineColOf } from "./lexer";

/**
 * The injected seams a type-checker needs (Spike C). `tscExePath` is a spawnable `tsc`/`tsgo`
 * executable already resolved from the INSTALLED `typescript` package
 * (`gate/model/tsc-extract.ts`'s `resolveCompilerPath()`, phase-8 Task 4) — this module does no
 * resolution of its own, only spawns the path it is handed. `runtimeDts` is the ambient
 * `@termcraft/runtime` declaration TEXT: the composition root injects `runtime/generated
 * /runtime-dts.ts`'s generated `RUNTIME_DTS` (Task 6) here rather than this module reading it
 * off disk, which is what keeps `gate` free of a `runtime` import (the module DAG's leaf rule).
 * The libs are NOT served here: they sit on disk next to the exe and the Go compiler reads them
 * itself (Spike C: "What the virtual FS is actually for").
 */
export interface TypeCheckerConfig {
  readonly tscExePath: string;
  readonly runtimeDts: string;
}

/**
 * A crashed / unavailable type-check subprocess (Spike C concern #4). The
 * `typescript/unstable/sync` API spawns the Go compiler over a named pipe and can
 * throw — including non-Error values at the Bun/Go boundary — so this wraps that
 * boundary. It NEVER means "the page is clean": a crash must surface as a fatal
 * `TYPE_CHECK_UNAVAILABLE` error, never as an empty diagnostic list.
 */
/**
 * The `GateError.code` a crashed or unconstructable compiler yields — ONE fatal for the whole
 * tree, with no `file`, deliberately so it is never mis-attributed to a page
 * (`core/ports/gate-runner.ts`'s `GateErrorV1.blockedPages`).
 *
 * EXPORTED because a consumer has to be able to tell this apart from every other diagnostic, and
 * a duplicated string literal is how that goes silently wrong. It says whether the compiler is up
 * — NOT anything about the tree's content — so a consumer caching results by tree content must
 * refuse to cache a report carrying it (`entrypoint/model/design-checker.ts`'s memo). Exported
 * rather than re-spelled there so a rename here is a compile error, not a silently disabled guard.
 */
export const TYPE_CHECK_UNAVAILABLE_CODE = "TYPE_CHECK_UNAVAILABLE";

export class TypeCheckUnavailableError extends errore.createTaggedError({
  name: "TypeCheckUnavailableError",
  message: "the TypeScript type-check subprocess was unavailable",
}) {}

/** Synthetic (never-written-to-disk) file basenames served over the virtual FS (Spike C). */
const TSCONFIG_NAME = "tsconfig.termcraft.json";
const RUNTIME_DTS_NAME = "__termcraft_runtime__.d.ts";

/** Normalize a path to forward slashes so VFS lookups match the compiler's requests. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * The synthesized compiler options (Spike C). Named separately from
 * {@link synthesizeTreeTsconfig} because it once had to stay BYTE-IDENTICAL across two configs
 * that differed only in their `files` array — the per-file program is gone (design-tree phase 2
 * Task 3), and the shape is kept so the options remain one readable, citable block.
 *
 * `lib: ["esnext"]` is PINNED and load-bearing: the default for `target: esnext` is
 * `lib.esnext.full.d.ts`, which pulls in `dom` + four other libs neither embedded nor
 * wanted in a TUI (where `document` must not exist). `strict` + `noEmit` +
 * `moduleResolution: bundler` + `jsx: react-jsx` mirror the runtime; `types: []` +
 * `skipLibCheck: true` keep the check hermetic.
 *
 * `jsxImportSource: "@termcraft/runtime"` (phase-8 WP-2) is the one field the hermetic
 * check cannot go without. `jsx: "react-jsx"` alone implies the factory module `react`,
 * and NOTHING resolves `react` from `os.tmpdir()` — so every JSX page, including a
 * perfectly valid one, failed with `TS2875 This JSX tag requires the module path
 * 'react/jsx-runtime' to exist`. Pointing it at the facade instead makes the factory
 * module `@termcraft/runtime/jsx-runtime`, which the generated `runtimeDts` declares
 * alongside the facade itself (`scripts/gen-runtime-dts.ts`, `buildJsxSubmodules`) —
 * exactly the wiring `src/runtime/model/jsx.ts`'s own NOTE names as the phase-8 job.
 * This affects the TYPE CHECK only; the transform that renders a saved page is Bun's.
 *
 * WHAT `skipLibCheck: true` COSTS, PER SPECIFIER — stated here because it is a property of THESE
 * options, not of the declaration alone, and because the generator's matching claim ("the
 * unresolved specifiers are harmless to the Gate") was RETRACTED on 2026-08-09 after it turned
 * out to be false for one of them. Nothing resolves a bare specifier from `os.tmpdir()`, and
 * `skipLibCheck` suppresses the `TS2307` a served `.d.ts` would otherwise raise, so any specifier
 * the declaration still names by reference degrades to `any`:
 *
 *  - `@reatom/core` — RESOLVED, since 2026-08-09. `scripts/gen-runtime-dts.ts` inlines the real
 *    installed package as a second ambient module inside the same `runtimeDts` text. Before that,
 *    `atom` was `any`, a type argument on an `any` callee was ignored, and `.map()` on the result
 *    had no contextual signature — so this check MANUFACTURED fatal `TS7006`s against
 *    correctly-typed pages while being unable to catch a misspelled field on atom state at all.
 *    Both directions are pinned in `type-check.test.ts` (spec WP-4, spike 10).
 *  - `@reatom/react` (`reatomComponent`) — still unresolved, so a component's return type is
 *    unchecked. It cannot be inlined honestly: its declaration imports `React` from `react`, and
 *    `@types/react` is not installed anywhere in this project (`react@19` ships none).
 *  - `@opentui/react/jsx-runtime` + `/jsx-dev-runtime`, and the unqualified `React.ReactNode` —
 *    unresolved for the same reason. ONE MEASURED CONSEQUENCE IS A DEFECT, not a soft gap:
 *    `JSX.IntrinsicElements` lives in that unresolved namespace, so every LOWERCASE raw element
 *    (`<box>`, `<text>`) — the escape hatch the agent prompt actively teaches, and the one
 *    `lints.ts`'s `lintUnpointedElements` presumes is legal — is a fatal `TS7026`. Pinned as a
 *    failing-behaviour fixture in `type-check.test.ts`; the fix is a declaration decision.
 *  - `@standard-schema/spec` — unresolved, and it is here only because the `@reatom/core` inline
 *    brought it: the package's own declaration imports `StandardSchemaV1` from it, so that import
 *    rides into the ambient block (kept rather than stripped — `gen-runtime-dts.ts`'s
 *    `buildReatomCoreBlock` states why). Its practical cost today is NIL, and that is checked
 *    rather than assumed: `StandardSchemaV1` is reachable only through Reatom's persistence, form
 *    and routing types, and the facade re-exports none of those — only
 *    `atom`/`computed`/`action`/`wrap`/`with*` and `Atom`/`Action`/`Computed`/`AtomLike`/`Ext`
 *    (`src/runtime/model/reatom.ts`). Nothing a design page can name reaches it. If the facade
 *    ever re-exports `withPersist`, `reatomField`/`reatomForm` or the routing surface, this line
 *    stops being free and the specifier has to be dealt with.
 *  - `@opentui/core` (`SyntaxStyle`, `StyleDefinitionInput`) — unresolved, added by plan P8 Task
 *    6's `runtime/model/syntax-style.ts`, which imports both directly. Cost today is NIL, and
 *    that is checked rather than assumed, the same way as `@standard-schema/spec` above:
 *    `syntax-style.ts`'s own exports (`activeSyntaxStyle`, `syntaxScopeStyles`, `buildSyntaxStyle`,
 *    `syntaxStyleAtom`, `SyntaxStyleUnavailableError`) DO reach the flattened declaration text —
 *    every file the program's graph touches gets flattened, not only what `index.ts` re-exports
 *    (the extra non-exported declarations this generator carries; a separate, reviewed and
 *    deliberately deferred item) — but none of them is named in `index.d.ts`'s own re-export
 *    list, so no page-visible identifier ever resolves to `SyntaxStyle`/`StyleDefinitionInput`.
 *    If the facade ever exports `activeSyntaxStyle` or a prop typed with one of these two names,
 *    this line stops being free.
 *  - `errore` (`FactoryTaggedErrorClass`, the base `SyntaxStyleUnavailableError_base` extends) —
 *    unresolved for the same reason and with the same measured, checked-nil cost: `errore` is
 *    used nowhere else under `src/runtime`, and `SyntaxStyleUnavailableError`'s own flattened
 *    class declaration is the same kind of inert, unreachable text described in the bullet above.
 *
 * A page's own PROP types are unaffected by all of this: every `*Props` interface is declared
 * inside the ambient block and is checked for real.
 */
const SYNTHESIZED_COMPILER_OPTIONS = {
  strict: true,
  jsx: "react-jsx",
  jsxImportSource: "@termcraft/runtime",
  noEmit: true,
  target: "esnext",
  module: "esnext",
  moduleResolution: "bundler",
  lib: ["esnext"],
  types: [],
  skipLibCheck: true,
};

/**
 * The synthesized tsconfig for the whole-tree program (Task 2, design §8 step 5): every
 * code file's synthetic absolute path plus the runtime `.d.ts`, so ONE `tsc` program sees
 * the entire module graph at once instead of N programs each blind to the others.
 */
function synthesizeTreeTsconfig(filePaths: readonly string[]): string {
  return JSON.stringify({
    compilerOptions: SYNTHESIZED_COMPILER_OPTIONS,
    files: filePaths,
  });
}

/**
 * Union of every diagnostic bucket, INCLUDING `getGlobalDiagnostics()` (Spike C, the
 * single most consequential rule): missing-lib / missing-global-type errors land ONLY
 * in the global bucket, so omitting it silently passes broken pages TypeScript proper
 * rejects. The union double-reports (a missing file surfaces in program + global at
 * once), which the caller dedupes on `(code, fileName, pos)`.
 */
function collectDiagnostics(program: {
  getConfigFileParsingDiagnostics(): readonly Diagnostic[];
  getProgramDiagnostics(): readonly Diagnostic[];
  getSyntacticDiagnostics(): readonly Diagnostic[];
  getSemanticDiagnostics(): readonly Diagnostic[];
  getGlobalDiagnostics(): readonly Diagnostic[];
}): readonly Diagnostic[] {
  return [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
}

/**
 * Map one diagnostic to a `GateError` (Task 2 difference #5). There is no single candidate file:
 * `d.fileName` is looked up against the tree's own `Map<absPath, {relPath, source}>` to find
 * which file (if any) the diagnostic belongs to. The API exposes a character-offset `pos` (not a
 * line/column), so the location is derived via `lineColOf` against THAT file's own source. A
 * diagnostic whose `fileName` names no tree file, or whose `pos` is negative (a file-level/global
 * diagnostic carries no position), gets no `file` and no location — an honest "the compiler said
 * this about the program, not about a page".
 */
function toGateErrorTree(
  d: Diagnostic,
  codeFiles: ReadonlyMap<string, { readonly relPath: string; readonly source: string }>,
): GateError {
  const entry = d.fileName !== undefined ? codeFiles.get(norm(d.fileName)) : undefined;
  if (entry === undefined || d.pos < 0)
    return { kind: "type", code: `TS${d.code}`, message: d.text };
  const loc = lineColOf(entry.source, d.pos);
  return {
    kind: "type",
    code: `TS${d.code}`,
    message: d.text,
    file: entry.relPath,
    line: loc.line,
    column: loc.column,
  };
}

/**
 * Dedupe on `(code, fileName, pos)` (Spike C: the diagnostic-bucket union double-reports, so a
 * missing file surfaces in program + global at once) and map each surviving diagnostic to a
 * `type`-kind `GateError`, resolved against whichever tree file (if any) it belongs to.
 */
function mapTreeDiagnostics(
  diags: readonly Diagnostic[],
  codeFiles: ReadonlyMap<string, { readonly relPath: string; readonly source: string }>,
): GateError[] {
  const seen = new Set<string>();
  const out: GateError[] = [];
  for (const d of diags) {
    const key = `${d.code}|${d.fileName ?? ""}|${d.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toGateErrorTree(d, codeFiles));
  }
  return out;
}

/** True for a C0/C1 control codepoint (incl. ESC), which a bounded plain-text message must not carry. */
function isControlCodePoint(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Bounded plain text with control bytes (incl. ESC / terminal sequences) replaced by
 * spaces and the whole string capped in length (host-supervision §13): a
 * `TYPE_CHECK_UNAVAILABLE` message may embed a compiler panic, which must never reach
 * a terminal as raw control sequences nor be unbounded.
 */
function boundedPlainText(raw: string): string {
  const sanitized = Array.from(raw, (ch) =>
    isControlCodePoint(ch.codePointAt(0) ?? 0) ? " " : ch,
  ).join("");
  const collapsed = sanitized.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

/** Compose the fatal-error message for an unavailable compiler, bounded and sanitized. */
function unavailableMessage(error: TypeCheckUnavailableError): string {
  const cause: unknown = error.cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return boundedPlainText(
    `type check unavailable — the TypeScript compiler subprocess failed: ${reason}`,
  );
}

/** One directory's immediate children (Task 2 difference #3) — basenames only, mirroring the compiler's own `FileSystemEntries` shape (`node_modules/typescript/dist/api/fs.d.ts:1-4`). */
interface DirEntries {
  readonly files: Set<string>;
  readonly directories: Set<string>;
}

/**
 * Build the synthetic directory tree implied by every absolute path the whole-tree VFS
 * serves (Task 2 difference #3): a `Map` from each directory's own absolute path to its
 * immediate children, keyed exactly as `directoryExists`/`getAccessibleEntries` are asked
 * about it below. `cwd` (the synthetic root) always exists, even for an empty tree.
 */
function buildSyntheticTree(cwd: string, absPaths: readonly string[]): Map<string, DirEntries> {
  const tree = new Map<string, DirEntries>();
  const ensureDir = (dir: string): DirEntries => {
    const existing = tree.get(dir);
    if (existing !== undefined) return existing;
    const created: DirEntries = { files: new Set(), directories: new Set() };
    tree.set(dir, created);
    return created;
  };
  ensureDir(cwd);
  for (const absPath of absPaths) {
    const segments = absPath.slice(cwd.length + 1).split("/");
    const fileName = segments.at(-1) ?? "";
    let currentDir = cwd;
    for (const segment of segments.slice(0, -1)) {
      ensureDir(currentDir).directories.add(segment);
      currentDir = `${currentDir}/${segment}`;
      ensureDir(currentDir);
    }
    if (fileName !== "") ensureDir(currentDir).files.add(fileName);
  }
  return tree;
}

/**
 * The whole-tree virtual FS (Task 2 difference #3): FIVE hooks, not the three the deleted
 * per-file program used. `readFile`/`fileExists`/`realpath` serve the tsconfig, the runtime
 * `.d.ts`, and every code file; `undefined` for anything else still means "read the real disk"
 * (difference #4), which is how the libs next to the exe are found.
 *
 * `directoryExists`/`getAccessibleEntries` are the two hooks the per-file program never
 * needed, because a program with one file has no sibling to resolve. MEASURED against the
 * real `tsc.exe` while writing this task: serving a sibling module's TEXT via `readFile` +
 * `fileExists` + `realpath` alone is NOT enough — module resolution short-circuits on the
 * DIRECTORY probe (`directoryExists` returning `undefined`, i.e. "no such directory") before
 * it ever calls `fileExists` on a candidate file inside it, so a real shared-module import
 * failed with `TS2307` even though the target file's content was being served correctly.
 * Adding these two — both members of the compiler API's own `FileSystem` interface
 * (`node_modules/typescript/dist/api/fs.d.ts:5-21`) — is what makes resolution work: a
 * directory exists iff it is the synthetic root or a prefix implied by some tree path
 * (`pages/`, `lib/`), and its accessible entries are exactly its immediate children in the
 * synthetic tree. Do not remove these as "redundant" with `readFile`/`fileExists` — they are
 * not; they answer a different, earlier question the resolver asks first.
 */
function createTreeVirtualFs(params: {
  readonly tsconfigPath: string;
  readonly tsconfig: string;
  readonly runtimeDtsPath: string;
  readonly runtimeDts: string;
  readonly codeFiles: ReadonlyMap<string, { readonly relPath: string; readonly source: string }>;
  readonly tree: ReadonlyMap<string, DirEntries>;
}): {
  readFile(name: string): string | null | undefined;
  fileExists(name: string): boolean | undefined;
  realpath(p: string): string | undefined;
  directoryExists(dir: string): boolean | undefined;
  getAccessibleEntries(dir: string): { files: string[]; directories: string[] } | undefined;
} {
  const { tsconfigPath, tsconfig, runtimeDtsPath, runtimeDts, codeFiles, tree } = params;
  return {
    readFile(name) {
      const n = norm(name);
      if (n === tsconfigPath) return tsconfig;
      if (n === runtimeDtsPath) return runtimeDts;
      return codeFiles.get(n)?.source;
    },
    fileExists(name) {
      const n = norm(name);
      if (n === tsconfigPath || n === runtimeDtsPath || codeFiles.has(n)) return true;
      return undefined;
    },
    realpath(p) {
      const n = norm(p);
      if (n === tsconfigPath || n === runtimeDtsPath || codeFiles.has(n)) return n;
      return undefined;
    },
    directoryExists(dir) {
      return tree.has(norm(dir)) ? true : undefined;
    },
    getAccessibleEntries(dir) {
      const entries = tree.get(norm(dir));
      if (entries === undefined) return undefined;
      return { files: [...entries.files], directories: [...entries.directories] };
    },
  };
}

/**
 * Run one hermetic type check over EVERY code file in the tree at once (Task 2, design §8
 * step 5). Mirrors {@link runTypeCheck}'s subprocess-boundary handling exactly (difference
 * #6): the API construction + `updateSnapshot` + diagnostic retrieval span is wrapped, any
 * failure becomes ONE `TypeCheckUnavailableError` for the WHOLE tree — never an empty list,
 * never silently attributed to a single page — and `api.close()` always runs, with a close
 * failure logged rather than turning a successful check into a crash.
 */
function runTreeTypeCheck(
  config: TypeCheckerConfig,
  files: ReadonlyMap<string, string>,
): GateError[] | TypeCheckUnavailableError {
  const cwd = norm(os.tmpdir());
  const tsconfigPath = `${cwd}/${TSCONFIG_NAME}`;
  const runtimeDtsPath = `${cwd}/${RUNTIME_DTS_NAME}`;

  // Difference #1: only CODE files are fed to the compiler and served over the VFS — the
  // SAME `isCodeFile` predicate the whole-tree scan and the closure walk key on, never a
  // second reading of "is this code". A non-code file is skipped entirely: not in the
  // synthesized tsconfig's `files`, not served by `readFile`/`fileExists`/`realpath`, and
  // not part of the synthetic directory tree either.
  const codeFiles = new Map<string, { relPath: string; source: string }>();
  for (const [relPath, source] of files) {
    if (!isCodeFile(relPath)) continue;
    codeFiles.set(norm(path.join(cwd, relPath)), { relPath, source });
  }

  // Difference #2: the synthesized tsconfig's `files` array is every code file's synthetic
  // absolute path plus the runtime declaration — compiler options are byte-identical to the
  // per-file program's via the shared `SYNTHESIZED_COMPILER_OPTIONS`.
  const tsconfig = synthesizeTreeTsconfig([...codeFiles.keys(), runtimeDtsPath]);
  const tree = buildSyntheticTree(cwd, [tsconfigPath, runtimeDtsPath, ...codeFiles.keys()]);
  const virtualFs = createTreeVirtualFs({
    tsconfigPath,
    tsconfig,
    runtimeDtsPath,
    runtimeDts: config.runtimeDts,
    codeFiles,
    tree,
  });

  // Raw try/catch at the subprocess boundary — NOT `errore.try`: the Bun/Go bridge can throw
  // NON-Error values, which `errore.try` re-throws rather than wrapping (Spike C concern #4; the
  // plan's global constraints). So this boundary catches `unknown` itself and returns the failure
  // as a domain-error value.
  try {
    const api = new API({ cwd, tsserverPath: config.tscExePath, fs: virtualFs });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
      const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0];
      if (project === undefined)
        return new TypeCheckUnavailableError({
          cause: new Error("no project loaded from the synthesized tree tsconfig"),
        });
      return mapTreeDiagnostics(collectDiagnostics(project.program), codeFiles);
    } finally {
      try {
        api.close();
      } catch (closeCause) {
        log.warn(
          "type-check (tree): api.close() failed:",
          closeCause instanceof Error ? closeCause.message : String(closeCause),
        );
      }
    }
  } catch (cause) {
    return new TypeCheckUnavailableError({ cause });
  }
}

/**
 * The gate's ONLY type check (Task 2, design §8 step 5): ONE `tsc` program over every code file
 * in the tree at once. It REPLACED a per-file `createTypeChecker`, deleted by Task 3 along with
 * its last caller, which could not see a sibling module at all — so a page importing shared code
 * always failed with a spurious `TS2307`. `files` is the SAME tree-relative path → source text
 * map the whole-tree scan already receives. Every returned error carries `file` set to the
 * tree-relative path it belongs to, with `line`/`column` derived from THAT file's own source; a
 * diagnostic the compiler attributes to no known tree file (a global/config diagnostic) carries
 * neither. A crashed or unavailable compiler yields a single fatal `TYPE_CHECK_UNAVAILABLE` error
 * for the WHOLE tree — NEVER an empty list, and never silently attributed to one page.
 *
 * WHO ATTRIBUTES A DIAGNOSTIC TO PAGES, and why not this function: `gate/adapters/gate-runner.ts`
 * 's `runTree` does, from the closures the same pass resolved. This primitive knows files, not
 * pages — it is handed a `files` map and no manifest — so a `blockedPages` computed here would
 * need a second reading of the import graph.
 *
 * MEASURED (Task 2 Step 5, 2026-08-03, Bun 1.3.14, this machine): a synthesized fixture of N
 * files (1 shared module + N-1 pages importing it) run through N sequential per-file
 * `createTypeChecker` calls (one per file, including the shared module itself) vs. ONE call to
 * this function over all N at once, wall-clock, real `tsc.exe`. Two independent runs, both
 * directionally identical:
 *
 * | N (files) | N × the deleted per-file program | 1 × `createTreeTypeChecker` |
 * | --------- | --------------------------------- | ---------------------------- |
 * |         3 |                   208ms / 164ms   |            63ms / 66ms       |
 * |        10 |                   499ms / 568ms   |            54ms / 70ms       |
 * |        30 |                  1681ms / 2674ms  |            72ms / 121ms      |
 *
 * The whole-tree program was FASTER than the N-program alternative at every measured N, by a
 * growing margin as N rises (it pays the subprocess-spin-up cost once instead of N times) —
 * consistent with the pre-task spike's own number (289ms for 3 files in one program vs
 * 2216ms for 2 per-file calls). The probe script that produced this table lives at
 * `.superpowers/sdd/2026-08-03-design-tree-phase-2-closure-graph/measure-task2.ts` — a
 * scratch tool, not part of this task's deliverable, not committed.
 */
export function createTreeTypeChecker(
  config: TypeCheckerConfig,
): (input: { readonly files: ReadonlyMap<string, string> }) => Promise<GateError[]> {
  return async ({ files }) => {
    const result = runTreeTypeCheck(config, files);
    if (result instanceof Error)
      return [
        { kind: "type", code: TYPE_CHECK_UNAVAILABLE_CODE, message: unavailableMessage(result) },
      ];
    return result;
  };
}

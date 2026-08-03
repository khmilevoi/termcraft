import os from "node:os";
import path from "node:path";

import * as errore from "errore";
import { API } from "typescript/unstable/sync";
import type { Diagnostic } from "typescript/unstable/sync";

import { isCodeFile } from "entities/design-tree";

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
 * The synthesized compiler options (Spike C), shared BYTE-IDENTICAL between the
 * per-file program ({@link synthesizeTsconfig}) and the whole-tree program
 * ({@link synthesizeTreeTsconfig}) — the two configs differ ONLY in their `files`
 * array, so this lives in one place rather than being copied twice and drifting.
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

/** The synthesized tsconfig for the per-file program: one candidate file plus the runtime `.d.ts`. */
function synthesizeTsconfig(candidatePath: string, runtimeDtsPath: string): string {
  return JSON.stringify({
    compilerOptions: SYNTHESIZED_COMPILER_OPTIONS,
    files: [candidatePath, runtimeDtsPath],
  });
}

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
 * Map one diagnostic to a `GateError`. The API exposes a character-offset `pos` (not
 * a line/column), so line/column are derived via `lineColOf` — but only for a
 * diagnostic that belongs to the candidate file (a global/config diagnostic has no
 * candidate position, so its location is omitted).
 */
function toGateError(
  d: Diagnostic,
  ctx: { source: string; candidatePath: string; fileName: string },
): GateError {
  const inCandidate =
    d.fileName !== undefined && norm(d.fileName) === ctx.candidatePath && d.pos >= 0;
  const loc = inCandidate ? lineColOf(ctx.source, d.pos) : null;
  return {
    kind: "type",
    code: `TS${d.code}`,
    message: d.text,
    ...(inCandidate ? { file: ctx.fileName } : {}),
    ...(loc !== null ? { line: loc.line, column: loc.column } : {}),
  };
}

/**
 * Dedupe on `(code, fileName, pos)` (Spike C: the union double-reports) and map each
 * surviving diagnostic to a `type`-kind `GateError`.
 */
function mapDiagnostics(
  diags: readonly Diagnostic[],
  ctx: { source: string; candidatePath: string; fileName: string },
): GateError[] {
  const seen = new Set<string>();
  const out: GateError[] = [];
  for (const d of diags) {
    const key = `${d.code}|${d.fileName ?? ""}|${d.pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toGateError(d, ctx));
  }
  return out;
}

/**
 * Map one diagnostic to a `GateError` for the WHOLE-TREE program (Task 2 difference #5):
 * unlike the per-file `toGateError`, there is no single candidate — `d.fileName` is looked
 * up against the tree's own `Map<absPath, {relPath, source}>` to find which file (if any)
 * the diagnostic belongs to. A diagnostic whose `fileName` names no tree file, or whose
 * `pos` is negative (a file-level/global diagnostic carries no position), keeps today's
 * shape: no `file`, no location — exactly the `inCandidate`-false branch of `toGateError`.
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
 * Dedupe on `(code, fileName, pos)` (same rule as {@link mapDiagnostics} — the union
 * double-reports) and map each surviving diagnostic to a `type`-kind `GateError`, resolved
 * against whichever tree file (if any) it belongs to.
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

/**
 * Run one hermetic type check over the candidate (Spike C). The API construction +
 * `updateSnapshot` + diagnostic retrieval are the subprocess boundary and can throw
 * (non-Error included), so the whole span is wrapped and any failure — including "no
 * project loaded" — becomes a `TypeCheckUnavailableError`. `api.close()` runs on every
 * path; a close failure is logged, never allowed to turn a successful check into a crash.
 */
function runTypeCheck(
  config: TypeCheckerConfig,
  source: string,
  fileName: string,
): GateError[] | TypeCheckUnavailableError {
  const cwd = norm(os.tmpdir());
  const candidatePath = norm(path.join(cwd, fileName));
  const tsconfigPath = `${cwd}/${TSCONFIG_NAME}`;
  const runtimeDtsPath = `${cwd}/${RUNTIME_DTS_NAME}`;
  const tsconfig = synthesizeTsconfig(candidatePath, runtimeDtsPath);

  // The virtual FS serves ONLY the three synthetic files — the tsconfig, the runtime
  // .d.ts, and the in-memory candidate. Everything else (the libs, next to the exe)
  // returns `undefined` = "read it off the real disk" (Spike C).
  const virtualFs = {
    readFile(name: string): string | null | undefined {
      const n = norm(name);
      if (n === tsconfigPath) return tsconfig;
      if (n === runtimeDtsPath) return config.runtimeDts;
      if (n === candidatePath) return source;
      return undefined;
    },
    fileExists(name: string): boolean | undefined {
      const n = norm(name);
      if (n === tsconfigPath || n === runtimeDtsPath || n === candidatePath) return true;
      return undefined;
    },
    realpath(p: string): string | undefined {
      const n = norm(p);
      if (n === tsconfigPath || n === runtimeDtsPath || n === candidatePath) return n;
      return undefined;
    },
  };

  // Raw try/catch at the subprocess boundary — NOT `errore.try`: the Bun/Go bridge can
  // throw NON-Error values, which `errore.try` re-throws rather than wrapping (Spike C
  // concern #4; the plan's global constraints). So this boundary catches `unknown`
  // itself and returns the failure as a domain-error value. `api.close()` runs on every
  // path; a close failure is logged, never allowed to turn a successful check into a crash.
  try {
    const api = new API({ cwd, tsserverPath: config.tscExePath, fs: virtualFs });
    try {
      const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });
      const project = snapshot.getProject(tsconfigPath) ?? snapshot.getProjects()[0];
      if (project === undefined)
        return new TypeCheckUnavailableError({
          cause: new Error("no project loaded from the synthesized tsconfig"),
        });
      return mapDiagnostics(collectDiagnostics(project.program), {
        source,
        candidatePath,
        fileName,
      });
    } finally {
      try {
        api.close();
      } catch (closeCause) {
        console.warn(
          "type-check: api.close() failed:",
          closeCause instanceof Error ? closeCause.message : String(closeCause),
        );
      }
    }
  } catch (cause) {
    return new TypeCheckUnavailableError({ cause });
  }
}

/**
 * Build the gate's `typeCheck` port (phase-3 T4, master §6.3 / Spike C): a checker
 * that type-checks one candidate page's source against the pinned esnext lib set and
 * the ambient runtime types, and returns fatal `type`-kind `GateError`s. A crashed or
 * unavailable compiler yields a single fatal `TYPE_CHECK_UNAVAILABLE` error — NEVER an
 * empty list — so "the checker never ran" can never read as "the page is clean".
 */
export function createTypeChecker(
  config: TypeCheckerConfig,
): (source: string, fileName: string) => Promise<GateError[]> {
  return async (source, fileName) => {
    const result = runTypeCheck(config, source, fileName);
    if (result instanceof Error)
      return [
        { kind: "type", code: "TYPE_CHECK_UNAVAILABLE", message: unavailableMessage(result) },
      ];
    return result;
  };
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
 * The whole-tree virtual FS (Task 2 difference #3): FIVE hooks, not the per-file program's
 * three. `readFile`/`fileExists`/`realpath` serve the tsconfig, the runtime `.d.ts`, and
 * every code file exactly as the per-file program does for its one candidate; `undefined`
 * for anything else still means "read the real disk" (difference #4), which is how the libs
 * next to the exe are found.
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

  // Same raw try/catch boundary as `runTypeCheck` — NOT `errore.try`: the Bun/Go bridge can
  // throw non-Error values, which `errore.try` re-throws rather than wrapping.
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
        console.warn(
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
 * Build the gate's WHOLE-TREE `typeCheck` primitive (Task 2, design §8 step 5): ONE `tsc`
 * program over every code file in the tree at once, replacing the per-file
 * {@link createTypeChecker} — which cannot see a sibling module at all, so a page importing
 * shared code always failed with a spurious `TS2307`. `files` is the SAME tree-relative
 * path → source text map the whole-tree scan already receives. Every returned error carries
 * `file` set to the tree-relative path it belongs to, with `line`/`column` derived from
 * THAT file's own source; a diagnostic the compiler attributes to no known tree file (a
 * global/config diagnostic) keeps today's shape — no `file`, no location. A crashed or
 * unavailable compiler yields a single fatal `TYPE_CHECK_UNAVAILABLE` error for the WHOLE
 * tree — NEVER an empty list, and never silently attributed to one page.
 *
 * Not wired to any port or caller yet — `createTypeChecker` stays in place, still used by
 * production code, until Task 3 deletes its last caller and deletes it along with the
 * per-file-only regression test in `type-check.test.ts`.
 *
 * MEASURED (Step 5, 2026-08-03, Bun 1.3.14, this machine): a synthesized fixture of N files
 * (1 shared module + N-1 pages importing it, mirroring the two tests above) run through N
 * sequential `createTypeChecker` calls (the per-file program, one per file, including the
 * shared module itself) vs. ONE `createTreeTypeChecker` call (this function) over all N at
 * once, wall-clock, real `tsc.exe`. Two independent runs, both directionally identical:
 *
 * | N (files) | N × per-file `createTypeChecker` | 1 × `createTreeTypeChecker` |
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
        { kind: "type", code: "TYPE_CHECK_UNAVAILABLE", message: unavailableMessage(result) },
      ];
    return result;
  };
}

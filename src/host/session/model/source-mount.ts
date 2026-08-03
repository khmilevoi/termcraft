import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

import * as errore from "errore";
import { z } from "zod";

import type { DesignFileEntryV1 } from "entities/design-tree";
import {
  isCodeFile,
  parsesJsx,
  resolveClosure,
  resolveDesignSpecifier,
} from "entities/design-tree";

import { ProtocolError } from "../../protocol";
import type { LoadPageArgs, LoadedPage, ValidatedPageMeta } from "../types";

/** The one legal bare module edge (runtime-api §2, design §6). */
const RUNTIME_SPECIFIER = "@termcraft/runtime";

/**
 * Specifiers `Bun.Transpiler.scanImports` reports as `require-call` for ANY
 * JSX-bearing source, regardless of what the file actually imports —
 * mechanical artifacts of the automatic JSX transform (empirically verified
 * against Bun 1.3.14: a JSX-free page produces no such records; a JSX-bearing
 * page always reports these two paths as `require-call`, in addition to
 * whatever it actually imports). They are exactly the two JSX-helper
 * specifiers the Task 1 resolver registers (`react/jsx-runtime` in prod mode,
 * `react/jsx-dev-runtime` in dev mode), plus the bare `react` require the dev
 * transform emits alongside them. Only the `require-call` kind is exempted —
 * an authored `import { useState } from "react"` reports as `import-statement`
 * for the same path (confirmed: `forbidden-react.tsx` reports BOTH an
 * `import-statement` "react" record for the authored import AND the phantom
 * `require-call` "react" record from the transform), so it is still caught.
 *
 * RESIDUAL GAP (defense-in-depth only): an author who writes a literal
 * `require("react")` / `require("react/jsx-runtime")` reports as `require-call`
 * for the same path as the phantom and is indistinguishable here — this scan would
 * let it through. Backstopped twice: the Gate's own scan is the AUTHORITATIVE
 * allowlist and separates an author-written require node from a transform-generated
 * one; and the resolver never registers bare `react`, so in the compiled binary such
 * a require fails to resolve and the file cannot load (no react access is gained).
 * Closing it in the host would need an AST scan — deferred to when the Gate's scanner
 * can be shared.
 */
const COMPILER_INJECTED_JSX_SPECIFIERS = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);

/** Lowercase-hex SHA-256 over the exact source bytes (host-supervision §3.1). */
export function computeSourceHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const malformed = (reason: string, cause?: unknown) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason, cause });

const sourceHashMismatch = (reason: string, cause?: unknown) =>
  new ProtocolError({ code: "SOURCE_HASH_MISMATCH", reason, cause });

/**
 * `Bun.Transpiler.scanImports` over one tree file, in the loader mode Bun's own parser would
 * use for that path ({@link parsesJsx}, `entities/design-tree`).
 *
 * THE LOADER IS NOT A DETAIL. Before the design tree a page was always `.tsx`, so a single
 * `{ loader: "tsx" }` transpiler was right by construction. A closure now spans `.ts`/`.mts`
 * files too, and a JSX parser reads `const x = <T>y;` in one of those as an unclosed element —
 * so a fixed `tsx` loader would turn ordinary, legal TypeScript into `MALFORMED_PROTOCOL` and
 * refuse to mount a page that the Gate passed and Bun runs. The predicate is the SAME measured
 * one the Gate keys its tokenizer on, imported rather than re-derived (task 12 controller ruling
 * #9: two independent readings of "what is this file" is how the two enforcement points came to
 * disagree).
 *
 * §5: unparseable source is a protocol violation, not a throw. `scanImports` throws a Bun
 * `BuildMessage` on syntactically broken source (a hash-matching but corrupt or hand-edited
 * tree reaches here). Crucially, `BuildMessage` is NOT an `instanceof Error`, so `errore.try`
 * would re-throw it (it only converts Error throws). This is the lowest-level boundary with
 * third-party code that throws a non-Error, so a raw try/catch inside an IIFE is the correct
 * adapter: catch ANY throw and convert it to a typed ProtocolError value.
 */
function scanFileImports(
  relPath: string,
  sourceText: string,
): ProtocolError | ReturnType<Bun.Transpiler["scanImports"]> {
  const transpiler = new Bun.Transpiler({
    loader: parsesJsx(relPath) === "jsx" ? "tsx" : "ts",
  });
  try {
    return transpiler.scanImports(sourceText);
  } catch (cause) {
    return malformed(`${relPath} is not parseable`, cause);
  }
}

/**
 * Re-scan every source in a page's closure for module edges before linking any of it
 * (runtime-api §3.1, §7.2 — "the host repeats the same import scan"; design §6's second
 * enforcement point). This is a defense-in-depth backstop: `gate/model/import-scan.ts` is
 * authoritative, and the resolver fails open, so a hand-edited canonical file or an old
 * historical snapshot that bypassed the Gate is caught here before any page code runs.
 *
 * WHAT CHANGED WITH THE DESIGN TREE. The pre-tree version scanned ONE file and rejected every
 * specifier that was not the exact root `@termcraft/runtime`. Relative edges are legal now
 * (design §6), so the check became a graph question: a specifier is legal when it is a static
 * import of the runtime, or when {@link resolveDesignSpecifier} resolves it to a real file
 * inside the tree. `has` is the caller's inventory predicate — the same set the closure walk
 * verified — never the sources map alone, because resolution has to see the tree the loader
 * sees (an unscanned sibling changes which candidate an extensionless probe lands on, which is
 * the hole task 12b closed on the Gate side).
 *
 * A `dynamic-import` or a `require-call` is fatal whatever it names, including the runtime
 * itself (runtime-api §3.1: only a STATIC import of the root specifier is accepted) — the one
 * exception is the JSX transform's own injected requires, see
 * {@link COMPILER_INJECTED_JSX_SPECIFIERS}. A re-export also reports `import-statement` and is
 * indistinguishable here, so "no re-export of the runtime" stays the Gate's job. Type-only
 * edges are erased by the transform and load no code, so `scanImports` may omit them; the
 * Gate's scan remains the authority for the type-only rule.
 */
export function scanClosureImports(input: {
  readonly sources: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): ProtocolError | void {
  for (const [from, sourceText] of input.sources) {
    const records = scanFileImports(from, sourceText);
    if (records instanceof ProtocolError) return records;
    for (const record of records) {
      if (record.kind === "require-call") {
        if (COMPILER_INJECTED_JSX_SPECIFIERS.has(record.path)) continue;
        return malformed(
          `${from}: require(${JSON.stringify(record.path)}) is not a legal module edge`,
        );
      }
      if (record.kind !== "import-statement") {
        return malformed(
          `${from}: ${record.kind} of ${JSON.stringify(record.path)} is not a legal module edge`,
        );
      }
      if (record.path === RUNTIME_SPECIFIER) continue;
      const resolved = resolveDesignSpecifier({
        from,
        specifier: record.path,
        has: input.has,
      });
      if (resolved instanceof Error) {
        return malformed(`${from}: ${JSON.stringify(record.path)} — ${resolved.reason}`);
      }
    }
  }
}

/**
 * Reject a tree-relative path that is not the plain forward-slash, inside-the-tree shape
 * `design/pages.json` and the Gate both speak. This duplicates `store/safe-fs`'s path rules
 * DELIBERATELY: the module DAG forbids `host` importing `store`, and `store/safe-fs` remains the
 * authority at staging time — this is the mount-time restatement of the same discipline, so a
 * path that reached the supervisor some other way still cannot address anything outside
 * `treeRoot`. Kept to the shape question only; the symlink question is
 * {@link createTreePathVerifier}'s.
 */
function checkTreeRelPath(relPath: string): ProtocolError | void {
  if (relPath.length === 0) return malformed("a tree-relative path may not be empty");
  if (relPath.includes("\\"))
    return malformed(`tree-relative path ${JSON.stringify(relPath)} carries a backslash`);
  if (relPath.startsWith("/"))
    return malformed(`tree-relative path ${JSON.stringify(relPath)} is absolute`);
  if (/^[a-zA-Z]:/.test(relPath))
    return malformed(`tree-relative path ${JSON.stringify(relPath)} carries a drive letter`);
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return malformed(
        `tree-relative path ${JSON.stringify(relPath)} has an empty or traversing segment`,
      );
    }
  }
}

/**
 * Build ONE MOUNT's symlink verifier. The returned function `lstat`s every component of
 * `relPath` under `treeRoot` and refuses if any of them is a symlink, junction or other reparse
 * point (design §6: "a specifier whose resolution passes through a symlink, junction, or reparse
 * point" is fatal). `lstat` — never `stat` — is what makes this a check rather than a followed
 * link; on Windows a junction and a reparse point both report `isSymbolicLink()`.
 *
 * It also remembers the absolute prefixes it has already proved, so a shared module reached from
 * a deep entry no longer re-stats `lib/` and `lib/deep/` once per closure member.
 *
 * PER CALL, NEVER MODULE-LEVEL: a memo that outlived a mount would answer for a tree that has
 * since been replaced, which is the staleness class this whole file exists to refuse. Sound
 * WITHIN one mount for the same reason the hash verification is — if a directory turned into a
 * link between two members of one closure, every byte this mount already read is suspect, and
 * the hash check is what catches that.
 *
 * The FINAL component is memoized only after its own check passes, exactly like every prefix, so
 * a file that is itself a symlink is still refused even when its directory was verified for a
 * sibling. That is not an implementation detail — it is what keeps the memo from becoming a
 * blanket pass, and it has its own test.
 *
 * `treeRoot` itself is NOT walked: it is the mount root the supervisor names, and everything
 * above it is the staging path's business. The same deliberate duplication of
 * `store/safe-fs/model/no-follow.ts`'s discipline as {@link checkTreeRelPath}, and for the same
 * reason — `host` may not import `store`.
 */
export function createTreePathVerifier(deps: {
  readonly lstat: (path: string) => Promise<Stats>;
}): (treeRoot: string, relPath: string) => Promise<ProtocolError | void> {
  const verified = new Set<string>();
  return async (treeRoot, relPath) => {
    const segments = relPath.split("/");
    let walked = treeRoot;
    for (const segment of segments) {
      walked = `${walked}/${segment}`;
      if (verified.has(walked)) continue;
      const stats = await deps.lstat(walked).catch(
        (cause) =>
          new ProtocolError({
            code: "SOURCE_HASH_MISMATCH",
            reason: `cannot stat ${relPath}`,
            cause,
          }),
      );
      if (stats instanceof ProtocolError) return stats;
      if (stats.isSymbolicLink())
        return malformed(`${relPath} resolves through a symlink or junction at ${segment}`);
      verified.add(walked);
    }
  };
}

/** One closure member read from disk, verified against the expected inventory, and decoded. */
interface ReadTreeFileV1 {
  readonly relPath: string;
  readonly sha256: string;
  /** `null` for a file Bun's loader does not execute — nothing reads its text (design §6). */
  readonly sourceText: string | null;
  /** The specifiers this file imports; empty for a non-code file. */
  readonly edges: readonly string[];
}

/**
 * Read, verify and decode ONE closure member.
 *
 * A non-code member ({@link isCodeFile}) is still read and hash-verified — it is part of the
 * closure and its bytes are part of what the page renders — but it is neither decoded as UTF-8
 * nor tokenized: Bun's loader never executes it, so it carries no module edge to find, and
 * pushing image or JSON bytes through a JS/TS parser could only ever manufacture a false
 * `MALFORMED_PROTOCOL`. That is the same measured criterion, and the same reasoning, as the
 * Gate's own scan loop.
 */
async function readTreeFile(
  treeRoot: string,
  relPath: string,
  expectedSha256: string,
  verifyPath: (treeRoot: string, relPath: string) => Promise<ProtocolError | void>,
): Promise<ProtocolError | ReadTreeFileV1> {
  const shapeError = checkTreeRelPath(relPath);
  if (shapeError instanceof ProtocolError) return shapeError;

  const linkError = await verifyPath(treeRoot, relPath);
  if (linkError instanceof ProtocolError) return linkError;

  const absolute = `${treeRoot}/${relPath}`;
  const bytes = await Bun.file(absolute)
    .bytes()
    .catch((cause) => sourceHashMismatch(`cannot read ${relPath} in the design tree`, cause));
  if (bytes instanceof ProtocolError) return bytes;

  const sha256 = computeSourceHash(bytes);
  if (sha256 !== expectedSha256) {
    return sourceHashMismatch(
      `source hash mismatch for ${relPath}: expected ${expectedSha256}, computed ${sha256}`,
    );
  }

  if (!isCodeFile(relPath)) return { relPath, sha256, sourceText: null, edges: [] };

  // §5: invalid UTF-8 is a protocol violation, not a throw. TextDecoder with { fatal: true }
  // throws on bad bytes, so wrap this sync boundary (errore rule 12, { try, catch } options
  // form per the installed errore@0.14.1).
  const sourceText = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => malformed(`${relPath} is not valid UTF-8`, cause),
  });
  if (sourceText instanceof ProtocolError) return sourceText;

  const records = scanFileImports(relPath, sourceText);
  if (records instanceof ProtocolError) return records;

  // The JSX transform's own injected requires are dropped here, not carried as edges: they are
  // bare specifiers no author wrote, so a closure walk that kept them would refuse EVERY
  // JSX-bearing page on `react/jsx-dev-runtime`. `scanClosureImports` exempts exactly the same
  // records — see {@link COMPILER_INJECTED_JSX_SPECIFIERS} for the measurement and the residual.
  const edges = records
    .filter(
      (record) =>
        !(record.kind === "require-call" && COMPILER_INJECTED_JSX_SPECIFIERS.has(record.path)),
    )
    .map((record) => record.path);

  return { relPath, sha256, sourceText, edges };
}

/**
 * Walk the entry's closure over the real filesystem, verifying every member against
 * `expectedFiles` before anything is decoded or linked (design §9.2, narrowed to one page's
 * closure because in this plan an incarnation still serves one page).
 *
 * The walk resolves each edge through {@link resolveDesignSpecifier} against the EXPECTED
 * INVENTORY, which is what makes the read set exactly the set Bun will load: task 12b measured
 * that wherever the design resolver resolves at all it names the same file Bun's own resolution
 * order lands on. An edge that does NOT resolve is skipped here rather than refused, because
 * refusing is {@link scanClosureImports}' job and stating the rule once is what keeps the two
 * from drifting apart — a skipped edge cannot hide anything, since the file it fails to name is
 * one this walk then never vouches for.
 */
async function readClosure(
  args: LoadPageArgs,
  has: (relPath: string) => boolean,
  sha256Of: (relPath: string) => string | undefined,
  verifyPath: (treeRoot: string, relPath: string) => Promise<ProtocolError | void>,
): Promise<ProtocolError | ReadonlyMap<string, ReadTreeFileV1>> {
  const read = new Map<string, ReadTreeFileV1>();
  const queue: string[] = [args.entryRelPath];
  const seen = new Set<string>([args.entryRelPath]);

  while (queue.length > 0) {
    const relPath = queue.shift();
    if (relPath === undefined) break;
    const expectedSha256 = sha256Of(relPath);
    if (expectedSha256 === undefined) {
      // Unreachable for anything but the entry: every other path enters the queue only after
      // `resolveDesignSpecifier` resolved it against `has`, which IS the expected inventory.
      return malformed(`${relPath} is not listed in the mount's expected design-tree inventory`);
    }
    const file = await readTreeFile(args.treeRoot, relPath, expectedSha256, verifyPath);
    if (file instanceof ProtocolError) return file;
    read.set(relPath, file);

    for (const specifier of file.edges) {
      const resolved = resolveDesignSpecifier({ from: relPath, specifier, has });
      if (resolved instanceof Error) continue;
      if (resolved.kind === "runtime") continue;
      if (seen.has(resolved.relPath)) continue;
      seen.add(resolved.relPath);
      queue.push(resolved.relPath);
    }
  }

  return read;
}

/**
 * Load and validate a page module together with its whole closure (host-supervision §6.5-6.6,
 * runtime-api §7.2, design §6 and §9.2).
 *
 * The supervisor supplies the tree root, the entry's tree-relative path (whatever
 * `design/pages.json` bound to the slug — never a slug-derived guess) and the expected
 * inventory of the tree revision being mounted. In order, and each step's reason:
 *
 * 1. Walk the closure from the entry, reading and hash-verifying EVERY member against
 *    `expectedFiles`. A missing file or a drifted hash anywhere in the closure is
 *    `SOURCE_HASH_MISMATCH` and no code is imported — a shared module whose bytes moved
 *    changes what the page renders just as surely as the entry's own bytes moving.
 * 2. Decode each code member to UTF-8 with `{ fatal: true }`.
 * 3. {@link scanClosureImports} over the decoded sources — the graph-aware rescan.
 * 4. Re-derive the closure with `entities/design-tree`'s own {@link resolveClosure} and refuse
 *    unless it names EXACTLY the set step 1 read. A file the walk names but never verified
 *    would be a silent extra import; a file it verified but the closure does not name would
 *    mean this module read something the page does not use. Neither is a state a mount may
 *    proceed from, and asking the entity that owns closure semantics is what keeps this file
 *    from becoming a second definition of "closure".
 * 5. `import()` the entry's absolute path and validate `meta` + the default export, as before.
 *
 * Every boundary (`lstat`, `Bun.file`, the UTF-8 decode, `scanImports`, `import()`) is wrapped
 * and carries its `cause`: a read/decode/link failure becomes a typed `ProtocolError`, never a
 * throw.
 */
export async function loadPage(args: LoadPageArgs): Promise<ProtocolError | LoadedPage> {
  const shaByRelPath = new Map(args.expectedFiles.map((file) => [file.relPath, file.sha256]));
  const has = (relPath: string): boolean => shaByRelPath.has(relPath);
  const sha256Of = (relPath: string): string | undefined => shaByRelPath.get(relPath);

  if (!has(args.entryRelPath)) {
    return malformed(
      `the mount's entry ${JSON.stringify(args.entryRelPath)} is not listed in its expected design-tree inventory`,
    );
  }

  const verifyPath = createTreePathVerifier({ lstat });
  const read = await readClosure(args, has, sha256Of, verifyPath);
  if (read instanceof ProtocolError) return read;

  const sources = new Map<string, string>();
  for (const [relPath, file] of read) {
    if (file.sourceText !== null) sources.set(relPath, file.sourceText);
  }

  const scanError = scanClosureImports({ sources, has });
  if (scanError instanceof ProtocolError) return scanError;

  const closure = resolveClosure({
    entry: args.entryRelPath,
    has,
    edgesOf: (relPath) => read.get(relPath)?.edges ?? [],
  });
  if (closure instanceof Error) {
    return malformed(
      `the closure of ${args.entryRelPath} does not resolve: ${closure.reason}`,
      closure,
    );
  }
  if (closure.files.length !== read.size || closure.files.some((relPath) => !read.has(relPath))) {
    return malformed(
      `the closure of ${args.entryRelPath} names ${closure.files.length} file(s) but ${read.size} were verified`,
    );
  }

  const entry = read.get(args.entryRelPath);
  if (entry === undefined) {
    // Defensive only: `readClosure` seeds its queue with the entry and returns early on any
    // failure, so a returned map always holds it. Never assumed silently (errore rule 21).
    return malformed(`the entry ${args.entryRelPath} was not read`);
  }

  const absoluteEntry = `${args.treeRoot}/${args.entryRelPath}`;
  const linked = await import(absoluteEntry).catch((cause) =>
    malformed(`failed to link page at ${args.entryRelPath}`, cause),
  );
  if (linked instanceof ProtocolError) return linked;

  const meta = validateMeta((linked as { meta?: unknown }).meta);
  if (meta instanceof ProtocolError) return meta;

  const component = (linked as { default?: unknown }).default;
  if (typeof component !== "function") {
    return malformed("page default export must be a component function");
  }

  return { meta, component, sourceHash: entry.sha256 };
}

const THEME_MAX = 64;
const TITLE_MAX = 256;
const AXIS_MAX = 2048;

const pageSizeSchema = z.object({
  w: z.number().int().positive().max(AXIS_MAX),
  h: z.number().int().positive().max(AXIS_MAX),
});

const pageMetaSchema = z.object({
  kitApiVersion: z.number().int().positive(),
  title: z.string().min(1).max(TITLE_MAX),
  theme: z.string().min(1).max(THEME_MAX),
  minSize: pageSizeSchema,
});

/** Structurally validate the imported `meta` (runtime-api §4 static contract). */
function validateMeta(value: unknown): ProtocolError | ValidatedPageMeta {
  const result = pageMetaSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue !== undefined && issue.path.length > 0 ? issue.path.join(".") : "meta";
    return malformed(`${path}: ${issue?.message ?? "invalid page meta"}`);
  }
  return result.data;
}

/** Re-exported so `LoadPageArgs` consumers do not redeclare the tree's own file-entry shape. */
export type { DesignFileEntryV1 };

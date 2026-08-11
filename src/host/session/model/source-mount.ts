import type { Stats } from "node:fs";

import * as errore from "errore";
import { z } from "zod";

import { DESIGN_SYSTEM_MANIFEST_RELPATH, decodeDesignSystemManifest } from "entities/design-system";
import type { DesignFileEntryV1 } from "entities/design-tree";
import {
  isCodeFile,
  parsesJsx,
  resolveClosure,
  resolveDesignSpecifier,
} from "entities/design-tree";
import { trace } from "infrastructure/debug-log";
import type { TokenMap } from "runtime/types";

import { ProtocolError } from "../../protocol";
import type {
  LoadPageArgs,
  LoadThemeSeedArgs,
  LoadedPage,
  ThemeSeedV1,
  ValidatedPageMeta,
} from "../types";

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
 * PER INCARNATION, NEVER MODULE-LEVEL: a memo that outlived the incarnation would answer for a
 * tree revision that has been replaced, which is the staleness class this whole file exists to
 * refuse. Sound WITHIN one incarnation for the same reason the hash verification is — if a
 * directory turned into a link between two members of one closure (whether both are read in the
 * same mount or across two mounts this incarnation serves), every byte already read is suspect,
 * and the hash check is what catches that. An incarnation does not outlive its revision (Task 5,
 * not yet landed, will make this literally true; today it is still the right invariant to state)
 * — the same assumption {@link createPageLoader}'s `verified` map rests on, one scope wider than
 * this verifier used to be memoized at.
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
 * closure and its bytes are part of what the page renders — but by default it is neither decoded
 * as UTF-8 nor tokenized: Bun's loader never executes it, so it carries no module edge to find,
 * and pushing image or JSON bytes through a JS/TS parser could only ever manufacture a false
 * `MALFORMED_PROTOCOL`. That is the same measured criterion, and the same reasoning, as the
 * Gate's own scan loop.
 *
 * `options.decodeText` is the ONE opt-in, added for {@link createThemeSeedLoader}: the design
 * system manifest (`system/design-system.json`) is JSON, so `isCodeFile` correctly says Bun never
 * executes it — but the theme loader still needs its TEXT, not just its verified hash, to decode
 * it. Every existing caller (`readClosure`'s closure walk) never passes this flag, so a binary or
 * prose closure member is still never pushed through `TextDecoder`'s `{ fatal: true }` decode,
 * except when a caller names ONE specific, known-text relPath — never a caller-chosen or
 * arbitrary one. The import scanner ({@link scanFileImports}) still runs ONLY for a code file
 * either way: a decoded-on-request non-code member carries no edges to find, same as before.
 */
async function readTreeFile(
  treeRoot: string,
  relPath: string,
  expectedSha256: string,
  verifyPath: (treeRoot: string, relPath: string) => Promise<ProtocolError | void>,
  options: { readonly decodeText?: boolean } = {},
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

  const isCode = isCodeFile(relPath);
  if (!isCode && options.decodeText !== true) {
    return { relPath, sha256, sourceText: null, edges: [] };
  }

  // §5: invalid UTF-8 is a protocol violation, not a throw. TextDecoder with { fatal: true }
  // throws on bad bytes, so wrap this sync boundary (errore rule 12, { try, catch } options
  // form per the installed errore@0.14.1).
  const sourceText = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => malformed(`${relPath} is not valid UTF-8`, cause),
  });
  if (sourceText instanceof ProtocolError) return sourceText;

  // A non-code member decoded only because `options.decodeText` asked for it still carries no
  // module edge to scan (Bun's loader never executes it) — return before the import scanner.
  if (!isCode) return { relPath, sha256, sourceText, edges: [] };

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
 *
 * `verified`/`readCache` are {@link createPageLoader}'s per-incarnation memo, not per-call state:
 * a member already proved by an earlier mount in this incarnation is served from `readCache`
 * instead of being read again — see the rationale on `verified`'s own declaration.
 */
async function readClosure(
  args: LoadPageArgs,
  has: (relPath: string) => boolean,
  sha256Of: (relPath: string) => string | undefined,
  verifyPath: (treeRoot: string, relPath: string) => Promise<ProtocolError | void>,
  verified: Map<string, string>,
  readCache: Map<string, ReadTreeFileV1>,
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

    const provenSha256 = verified.get(relPath);
    if (provenSha256 !== undefined && provenSha256 !== expectedSha256) {
      // The SAME path with a DIFFERENT expected hash means the caller handed this incarnation
      // two different tree revisions. That is a supervisor bug, not a drifted file: an
      // incarnation is keyed by revision (design §9.2) and its inventory is fixed for its whole
      // life. Refuse loudly rather than link a module verified against somebody else's inventory.
      return sourceHashMismatch(
        `${relPath} was verified as ${provenSha256} earlier in this incarnation but this mount expects ${expectedSha256}`,
      );
    }

    // A member this incarnation already proved is served from `readCache` instead of being
    // read again — see "AND WHY A VERIFIED MEMBER IS NOT RE-READ" on `verified`'s declaration in
    // {@link createPageLoader}: once linked, `import()`/`deps.link` serves the cached module for
    // the rest of the process, so re-reading bytes now could only produce a hash for bytes that
    // are not what is running.
    const file =
      readCache.get(relPath) ??
      (await readTreeFile(args.treeRoot, relPath, expectedSha256, verifyPath));
    if (file instanceof ProtocolError) return file;
    read.set(relPath, file);
    verified.set(relPath, file.sha256);
    readCache.set(relPath, file);

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

/** The dependencies one incarnation's page loader closes over. Both fields are REQUIRED — no
 * default value lives inside {@link createPageLoader}, so a caller can never silently fall back
 * to a production behavior it did not ask for. */
export interface PageLoaderDeps {
  /**
   * Link one absolute module path and return its exports. §9.5's SEAM, and the only route page
   * code takes into this process. Today `entry.ts` supplies `(absPath) => import(absPath)`; a
   * future in-process module registry (own transpile + own `Map`-backed linker, invalidating
   * changed modules and their importers by reverse edge) replaces THIS ONE FUNCTION and nothing
   * else. That registry is deliberately not built by this plan: its only gain over the
   * revision-keyed incarnation is avoiding one respawn per edit, and the warm spare already
   * pre-pays that cost.
   */
  readonly link: (absolutePath: string) => Promise<unknown>;
  /** `node:fs/promises`' `lstat`, injected so the symlink refusal is testable. */
  readonly lstat: (path: string) => Promise<Stats>;
}

/**
 * Build ONE INCARNATION's page loader (design §9.2, §9.5). `createPageLoader` closes over
 * exactly two pieces of per-incarnation state and returns a function with the same signature
 * `loadPage` used to have as a free function:
 *
 * - `verifyPath`, {@link createTreePathVerifier}'s symlink memo, now spans the whole incarnation
 *   rather than one mount (see the widened "PER INCARNATION" argument on that function).
 * - `verified`/`readCache`, this factory's own memo of every closure member this incarnation has
 *   already hash-verified, so a second mount that shares a module with an earlier one in the
 *   same incarnation never re-reads it.
 *
 * ONE LOADER PER PROCESS = one per incarnation: its verified-file set and its symlink memo are
 * facts about THIS tree revision, and one `_host` child process serves exactly one (`entry.ts`
 * builds it once, outside `createHostSession`).
 */
export function createPageLoader(
  deps: PageLoaderDeps,
): (args: LoadPageArgs) => Promise<ProtocolError | LoadedPage> {
  const verifyPath = createTreePathVerifier({ lstat: deps.lstat });

  /**
   * Tree-relative path → the sha256 THIS INCARNATION proved for it.
   *
   * AND WHY A VERIFIED MEMBER IS NOT RE-READ. Once a file has been linked, `import()` serves the
   * cached module for the rest of the process. Re-reading its bytes on a later mount can only
   * produce a hash for bytes that are not what is running — so a "drift" found there would be
   * reported against code the incarnation is not executing. The honest answer to a tree that
   * moved under a live incarnation is that the revision moved, which closes this incarnation
   * outright (Task 5). Record this at the call site; it is a decision, not an optimisation.
   */
  const verified = new Map<string, string>();

  /** The decoded {@link ReadTreeFileV1} (with its `edges`) for every member `verified` has
   * proved, so `readClosure`'s closure re-derivation still has every already-verified member's
   * edges without a second read. */
  const readCache = new Map<string, ReadTreeFileV1>();

  /**
   * Load and validate a page module together with its whole closure (host-supervision §6.5-6.6,
   * runtime-api §7.2, design §6 and §9.2).
   *
   * The supervisor supplies the tree root, the entry's tree-relative path (whatever
   * `design/pages.json` bound to the slug — never a slug-derived guess) and the expected
   * inventory of the tree revision being mounted. In order, and each step's reason:
   *
   * 1. Walk the closure from the entry, reading and hash-verifying every member THIS
   *    INCARNATION HAS NOT ALREADY PROVED against `expectedFiles`. A missing file or a drifted
   *    hash anywhere in the closure is `SOURCE_HASH_MISMATCH` and no code is imported — a shared
   *    module whose bytes moved changes what the page renders just as surely as the entry's own
   *    bytes moving. A member this incarnation already verified is not re-read (see `verified`
   *    above) and the SAME guarantee still holds, because nothing is ever linked that was not
   *    hash-verified against this revision's inventory at some point in this incarnation's life.
   * 2. Decode each code member to UTF-8 with `{ fatal: true }`.
   * 3. {@link scanClosureImports} over the decoded sources — the graph-aware rescan.
   * 4. Re-derive the closure with `entities/design-tree`'s own {@link resolveClosure} and refuse
   *    unless it names EXACTLY the set step 1 read. A file the walk names but never verified
   *    would be a silent extra import; a file it verified but the closure does not name would
   *    mean this module read something the page does not use. Neither is a state a mount may
   *    proceed from, and asking the entity that owns closure semantics is what keeps this file
   *    from becoming a second definition of "closure".
   * 5. `deps.link` the entry's absolute path (§9.5's seam — `(absPath) => import(absPath)` today)
   *    and validate `meta` + the default export, as before.
   *
   * Every boundary (`lstat`, `Bun.file`, the UTF-8 decode, `scanImports`, `deps.link`) is wrapped
   * and carries its `cause`: a read/decode/link failure becomes a typed `ProtocolError`, never a
   * throw.
   */
  return async function loadPage(args: LoadPageArgs): Promise<ProtocolError | LoadedPage> {
    const shaByRelPath = new Map(args.expectedFiles.map((file) => [file.relPath, file.sha256]));
    const has = (relPath: string): boolean => shaByRelPath.has(relPath);
    const sha256Of = (relPath: string): string | undefined => shaByRelPath.get(relPath);

    if (!has(args.entryRelPath)) {
      return malformed(
        `the mount's entry ${JSON.stringify(args.entryRelPath)} is not listed in its expected design-tree inventory`,
      );
    }

    const read = await readClosure(args, has, sha256Of, verifyPath, verified, readCache);
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
    const linked = await deps
      .link(absoluteEntry)
      .catch((cause) => malformed(`failed to link page at ${args.entryRelPath}`, cause));
    if (linked instanceof ProtocolError) return linked;

    const meta = validateMeta((linked as { meta?: unknown }).meta);
    if (meta instanceof ProtocolError) return meta;

    const component = (linked as { default?: unknown }).default;
    if (typeof component !== "function") {
      return malformed("page default export must be a component function");
    }

    return { meta, component, sourceHash: entry.sha256 };
  };
}

/**
 * Widen a manifest theme's Gate-validated `#rrggbb` record into the runtime's typed `TokenMap` —
 * the SAME widen-then-single-assertion idiom `host-state-machine.ts`'s `readyBodyRecord` already
 * uses, reused here rather than invented fresh. This performs no NEW validation: every value was
 * already checked against `#rrggbb` by `decodeDesignSystemManifest`'s Zod schema (design-systems
 * §4.1) before it ever reaches this function — it only reshapes an already-checked `Record` into
 * the shape `seedThemeCapability` (`runtime/model/tokens`) requires.
 */
function toTokenMap(tokens: Readonly<Record<string, string>>): TokenMap {
  const widened: Record<string, unknown> = { ...tokens };
  return widened as TokenMap;
}

/**
 * The theme seed loader (design-systems §4.6). It is in THIS module rather than beside the state
 * machine because this is where a tree file is read and hash-verified against `expectedFiles`; a
 * second reader would be a second answer to "what bytes are in this tree".
 *
 * WHY THE CHILD READS THE MANIFEST AT ALL, rather than the values riding the protocol: they are in
 * `design/system/design-system.json`, which is inside `treeRoot` and covered by `expectedFiles`, so
 * they already travel by the route everything else does. Adding them to the wire would put a
 * project's palette into the mount request and make the request's size a function of the project's
 * token count.
 */
export function createThemeSeedLoader(
  deps: PageLoaderDeps,
): (args: LoadThemeSeedArgs) => Promise<ProtocolError | ThemeSeedV1 | null> {
  const verifyPath = createTreePathVerifier({ lstat: deps.lstat });

  return async (args) => {
    const entry = args.expectedFiles.find(
      (file) => file.relPath === DESIGN_SYSTEM_MANIFEST_RELPATH,
    );
    // ABSENT IS NOT A FAILURE (P2's D8, applied at the host): a tree that predates the mechanical
    // migration mounts exactly as it does today, against the runtime's compiled defaults.
    if (entry === undefined) return null;

    const read = await readTreeFile(args.treeRoot, entry.relPath, entry.sha256, verifyPath, {
      decodeText: true,
    });
    if (read instanceof ProtocolError) return read;

    // Defensive only (errore rule 21, never silently assumed): `decodeText: true` above always
    // decodes a hash-verified read for a text file, so `sourceText` is never `null` here in
    // practice — the same "unreachable but stated" family as `createPageLoader`'s own `entry`
    // lookup a few lines above.
    if (read.sourceText === null) return malformed(`${entry.relPath} carried no decodable text`);

    const manifest = decodeDesignSystemManifest(read.sourceText);
    // LOUD HERE, unlike `core` (P4 D7): the child is DOWNSTREAM of the Gate, so a manifest that
    // does not decode means the bytes it was handed are not the bytes the Gate judged.
    if (manifest instanceof Error) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `${DESIGN_SYSTEM_MANIFEST_RELPATH} did not decode: ${manifest.message}`,
        cause: manifest,
      });
    }

    // `Object.hasOwn`, NOT bracket-access `!== undefined`: `manifest.themes` is a plain object off
    // a `z.record` and still carries `Object.prototype`, so `args.theme === "constructor"` (or
    // `toString`/`valueOf`/`hasOwnProperty`/`__proto__`) would otherwise resolve to an INHERITED
    // member instead of `undefined` — `requested.tokens` would then be `undefined`, and
    // `toTokenMap(undefined)` would silently seed an EMPTY token map with no `trace` and no
    // fatal, worse than either documented D2 outcome. `request.theme` is only bounded as a
    // non-empty string ≤64 chars on the wire (`host-state-machine.ts`'s `parseMountRequest`), and
    // `core/project`'s `resolveActiveThemeId` passes a page's declared `meta.theme` through
    // verbatim ("resolves; it does not validate"), so this is reachable. Same fix, same reasoning,
    // as `entities/design-system/model/manifest.ts`'s `TOKEN_PARITY`/`DEFAULT_THEME_UNDECLARED`
    // checks already apply to this identical hazard.
    // `Object.hasOwn`, NOT bracket-access `!== undefined`: `manifest.themes` is a plain object off
    // a `z.record` and still carries `Object.prototype`, so `args.theme === "constructor"` (or
    // `toString`/`valueOf`/`hasOwnProperty`/`__proto__`) would otherwise resolve to an INHERITED
    // member instead of `undefined` — `requested.tokens` would then be `undefined`, and
    // `toTokenMap(undefined)` would silently seed an EMPTY token map with no `trace` and no
    // fatal, worse than either documented D2 outcome. `request.theme` is only bounded as a
    // non-empty string ≤64 chars on the wire (`host-state-machine.ts`'s `parseMountRequest`), and
    // `core/project`'s `resolveActiveThemeId` passes a page's declared `meta.theme` through
    // verbatim ("resolves; it does not validate"), so this is reachable. Same fix, same reasoning,
    // as `entities/design-system/model/manifest.ts`'s `TOKEN_PARITY`/`DEFAULT_THEME_UNDECLARED`
    // checks already apply to this identical hazard.
    const requested = Object.hasOwn(manifest.themes, args.theme)
      ? manifest.themes[args.theme]
      : undefined;
    if (requested !== undefined) {
      return { themeId: args.theme, tokens: toTokenMap(requested.tokens) };
    }

    // FALLBACK, NOT A REFUSAL, and the value is the manifest's OWN declared default — read out of
    // the project, never invented here. See plan P4's decision D2 for the smoke-render case this
    // exists for. The Gate is what fatals a page's `meta.theme` naming an undeclared theme (§7).
    const fallback = manifest.themes[manifest.defaultTheme];
    if (fallback === undefined) return null;
    trace("host.mount.themeFallback", { requested: args.theme, used: manifest.defaultTheme });
    return { themeId: manifest.defaultTheme, tokens: toTokenMap(fallback.tokens) };
  };
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
  // OPTIONAL (design-systems §4.6): absent means the project manifest's `defaultTheme`, which
  // `core` has already resolved into `MountRequestBody.theme` by the time this runs. `.min(1)`
  // survives — an empty string names no theme and is corruption, not an absence.
  theme: z.string().min(1).max(THEME_MAX).optional(),
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

/**
 * Force `pageMetaSchema`'s Zod v4 fast-path validator to compile NOW, while `Function` is
 * still available in this realm. Call this BEFORE `host/session/model/capability-denial.ts`'s
 * `denyDynamicCodeCapability()`, never after.
 *
 * WHY THIS EXISTS (task 10, measured not assumed — see task-10-report.md for the stack).
 * `$ZodObjectJIT` (Zod v4's `core/schemas.js`) builds each object schema's compiled validator
 * with `new Function` the FIRST time that SPECIFIC schema instance is parsed in this process —
 * a per-schema, lazily-built, then-permanently-cached closure, entirely separate from the
 * schema's `Function`-availability PROBE (`util.js`'s `allowsEval`, itself a SEPARATE
 * process-wide memo that resolves once, gracefully, whichever schema touches it first). Denying
 * `Function` before THIS schema's own first `.safeParse()` call throws straight out of
 * `validateMeta`, uncaught — `loadPage` calls `import()` (running the page's own module code)
 * BEFORE `validateMeta`, so simply denying earlier would leave the page's module scope free to
 * run; denying later, without this warm-up, crashes every legitimate mount's OWN meta check.
 * `pageSizeSchema` (`minSize`'s type) is a SEPARATE, NESTED `z.object(...)` with its OWN
 * independent fastpass state — MEASURED, not assumed: warming with `{}` alone (no `minSize`)
 * left `pageSizeSchema`'s own compile untriggered, because the generated OUTER validator only
 * reaches the NESTED schema's own parse when the field is actually present, and a real page's
 * meta always carries one. The dummy value below is therefore STRUCTURALLY COMPLETE, not just
 * object-shaped, so both schemas compile here.
 */
export function warmPageMetaValidator(): void {
  pageMetaSchema.safeParse({
    kitApiVersion: 1,
    title: "warm-up",
    theme: "warm-up",
    minSize: { w: 1, h: 1 },
  });
}

/** Re-exported so `LoadPageArgs` consumers do not redeclare the tree's own file-entry shape. */
export type { DesignFileEntryV1 };

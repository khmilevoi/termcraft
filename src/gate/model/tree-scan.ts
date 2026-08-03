import * as errore from "errore";

import { isCodeFile, parsesJsx } from "entities/design-tree";

import type { ImportScanError } from "./import-scan";
import { scanImportAllowlist, scanModuleEdges } from "./import-scan";
import type { SourceStreamTruncatedError } from "./lexer";

export { scanModuleEdges };

/**
 * One tree file the allowlist scan could not read to the end. Carried as a value (never thrown
 * on) so {@link scanTreeImports} can report it as a fatal like any other finding.
 *
 * THE ONE MEASURED CAUSE, and why this exists at all. `./jsx`'s reader is recursive descent, so
 * absurdly deep JSX nesting exhausts the JS stack and the engine throws `RangeError: Maximum call
 * stack size exceeded`. Measured through this very function under Bun 1.3.14: `"<a>{".repeat(k)`
 * returns normally at 24 000 characters (3 375 ms, zero errors) and THROWS at 32 000; well-formed
 * `"<a>".repeat(k) + "x" + "</a>".repeat(k)` returns at 59 998 characters (140 ms) and throws at
 * 99 996. This is NOT introduced by the element memo — the same shapes overflow at the same order
 * of magnitude on the pre-memo reader, which simply never got that far on the unterminated one
 * because it hung first.
 *
 * `runTreeImports` (`gate/model/gate.ts`) is SYNCHRONOUS and Task 14 calls it once per turn with
 * no `try` of its own, so an escaping throw would crash the turn pipeline rather than reject a
 * page. Converting it here is the fail-closed outcome and the only honest one: the file was not
 * scanned, so it cannot be vouched for.
 *
 * DELIBERATELY NOT discriminated by error type. An earlier draft caught only `RangeError` and
 * rethrew everything else; that puts this module in the business of deciding which internal
 * failures are "expected", and a rethrow from here lands in exactly the caller that cannot handle
 * it. Every throw becomes this fatal instead, with the original attached as `cause` and its name
 * and message reproduced in the diagnostic, so a genuine bug surfaces as a loud rejected page
 * naming itself rather than as a silently swallowed error or a crashed turn.
 */
class TreeFileUnscannableError extends errore.createTaggedError({
  name: "TreeFileUnscannableError",
  message: 'the import scan could not read "$file" to the end',
}) {}

/**
 * The measured "does Bun EXECUTE this file's text as JS/TS" predicate, used at BOTH of this
 * module's enforcement points — one predicate, so the two can never disagree about what "code"
 * means:
 *
 * 1. the scan loop below SKIPS a file this returns false for even when its text sits in
 *    `input.files`: feeding prose, JSON or image bytes through a JS/TS tokenizer manufactures
 *    a fatal out of content that merely happens to spell a banned identifier, and the loader
 *    would never have run that content anyway;
 * 2. {@link isTrustedTarget} below REQUIRES a file this returns true for to be present in `files`
 *    before trusting a RESOLVED import to it, because a file the loader executes can itself hide
 *    a further forbidden import this pass never read (task-11 review, Important 2's hazard).
 *
 * Both follow from the same measured fact and would be wrong under any other reading of it: a
 * non-executed target carries no import syntax to miss, so demanding its text (point 2) or
 * tokenizing its bytes (point 1) could only ever produce a false diagnosis.
 *
 * MOVED to `entities/design-tree/model/code-file.ts` in task 15 and re-exported here unchanged
 * — read that file for the criterion, the 72-fixture measurement behind it, and its three named
 * residuals. It moved because `host/session/model/source-mount.ts`'s pre-mount closure walk
 * became a third consumer and `host` may not import `gate`; re-deriving the test there would
 * have produced the second, divergent reading task 12's controller ruling #9 exists about.
 * Re-exported (not merely imported) because `gate/adapters/gate-runner.ts` already imports it
 * from this module for its own `edgesOf`.
 */
export { isCodeFile };

/**
 * Whether Bun's parser reads a tree file's text as JSX — the measured predicate the whole-tree
 * scan and the closure walk both key their tokenizer mode on.
 *
 * MOVED to `entities/design-tree/model/code-file.ts` in task 15 for the same reason
 * {@link isCodeFile} was, and re-exported here unchanged: `host/session/model/source-mount.ts`
 * picks its `Bun.Transpiler` loader from exactly this question and `host` may not import `gate`.
 * Read that file for the measurement table and for what a wrong answer here costs (task 14b fix
 * round 1, Critical 1 — a `.ts` file's real code vanished from the token stream).
 */
export { parsesJsx };

/**
 * True when this pass HOLDS a resolution target's source: either the loader never executes it (so
 * it carries no import syntax to miss), or its source is a key in `files`. Handed to
 * {@link scanImportAllowlist} as `isScanned` — asked ONCE per scan, about the path
 * {@link resolveDesignSpecifier} settled on, never about a candidate on the way there.
 *
 * HOLDING A FILE'S SOURCE IS NOT THE SAME AS HAVING READ IT (task-12b round-1 re-review, Minor
 * M4). A file whose own scan failed — {@link TreeFileUnscannableError}, or a returned
 * `SourceStreamTruncatedError` — stays a key in `files`: its text is right there, untouched by
 * whatever stopped the scan from finishing. This predicate cannot tell the two apart, and must
 * not try to: it only ever sees the resolved path, never the outcome of scanning it. What
 * subtracts an unscannable file from the trusted set is {@link scanTreeImports}'s second phase,
 * which re-asks this same question with the files that failed already known and excluded — not
 * a change to what this function itself means.
 *
 * THE BUG THIS SHAPE CLOSES, and why the shape is the fix. Rounds 0 and 1 of task-12b both
 * answered this question through the resolver's own `has`, i.e. by claiming a present-but-
 * unscanned file did not exist. That merges two different questions into one boolean, and
 * `resolveDesignSpecifier` cannot tell them apart: it reads `false` as "no such file" and
 * ADVANCES to the next probe candidate. A different, scanned file then satisfies the import while
 * Bun loads the unscanned one. Two shapes of it were measured, and the second is why the second
 * round of latching was abandoned for this post-resolution question:
 *
 * ```
 * spec ../lib/foo   present [lib/foo(unscanned), lib/foo.tsx(scanned)]  Bun loads lib/foo
 * spec ../lib/foo   present [lib/foo.tsx(unscanned), lib/foo.ts(scanned)]  Bun loads lib/foo.tsx
 * ```
 *
 * Both were clean before; the first fell to a latch armed on the exact path, the second slipped
 * one probe step further down and needed a latch of its own. There is no bound on that game —
 * every candidate the resolver can advance past is another row — so the question is asked where
 * it actually belongs instead: after resolution, once, about the file the loader will run.
 *
 * WHY THE RESOLVED PATH IS THE FILE BUN RUNS. Measured on the real mount path (`await
 * import(<absolute path>)`, as `host/session/model/source-mount.ts:137` does), Bun 1.3.14, each
 * fixture in its OWN directory because Bun's module cache aliases paths across a case-insensitive
 * filesystem otherwise. All 32 present-subsets of `{foo, foo.tsx, foo.ts, foo.js, foo.json}`,
 * plus every explicit specifier, 160 fixtures: for `./lib/foo` Bun's order is
 *
 * ```
 * foo > foo.tsx > foo.ts > foo.js > foo.json > foo/index.tsx
 * ```
 *
 * of which `resolveDesignSpecifier`'s own `base > .tsx > .ts` is a strict PREFIX. So wherever the
 * design resolver resolves at all, it names exactly the file Bun loads; wherever it stops short
 * (only `.js`/`.json` or a directory index exists) it reports `UNRESOLVED_IMPORT`, which is fatal
 * — fail closed, never a wrong target. The explicit specifiers agree too: `./lib/foo.tsx` and
 * `./lib/foo.ts` load only their exact file, and `./lib/foo.js` loads `lib/foo.js` whenever it
 * exists (its `.ts`/`.tsx` fallback only fires when `lib/foo.js` does NOT exist, where the design
 * resolver refuses outright). The directory-index tail was measured separately — `foo.tsx`,
 * `foo.ts`, `foo.js` and `foo.json` each beat `foo/index.tsx`, and an extensionless `foo` cannot
 * be compared with it at all because one name cannot be both a file and a directory.
 *
 * NOT claimed: that Bun's map and §6's are the same map. They are not — Bun also serves
 * `.js`/`.jsx`/`.mjs`/`.cjs`, `.json` and a directory index for an extensionless specifier, and
 * §6 deliberately serves none of them. The claim is only the one soundness needs, and it is the
 * one the matrix checks: §6's order is a PREFIX of Bun's, so §6 never picks a DIFFERENT file than
 * Bun would — it either picks the same one or refuses. This lemma is executed, not asserted:
 * `tree-scan.test.ts`'s soundness-matrix test replays all 1215 (present x scanned x specifier)
 * rows against those measured loader outcomes.
 */
function isTrustedTarget(
  input: { readonly files: ReadonlyMap<string, string> },
  relPath: string,
): boolean {
  return !isCodeFile(relPath) || input.files.has(relPath);
}

/** One file's phase-1 outcome, kept so phase 2 can re-judge only what needs re-judging. */
interface FileScanV1 {
  /** The scan's own findings, or the failure that stopped it. Both error arms fold to the same
   * `UNSCANNABLE_SOURCE` diagnostic, exactly as the old single-pass body folded them. */
  readonly outcome:
    | TreeFileUnscannableError
    | SourceStreamTruncatedError
    | readonly ImportScanError[];
  /** Every tree path this file's scan asked `isScanned` about — i.e. every RESOLVED target it
   * has. Captured during the scan itself, so it costs nothing and cannot disagree with what
   * the scan actually resolved. */
  readonly targets: ReadonlySet<string>;
}

/**
 * Scan ONE file, capturing every target its trust question was asked about.
 *
 * `isUnscannable` lets phase 2 subtract files that turned out unreadable WITHOUT changing what
 * `isTrustedTarget` means — the two questions stay separate, which is the same separation
 * task 11 made between `has` and `isScanned`.
 */
function scanOne(
  input: {
    readonly files: ReadonlyMap<string, string>;
    readonly has: (relPath: string) => boolean;
  },
  from: string,
  source: string,
  isUnscannable: (relPath: string) => boolean,
): FileScanV1 {
  const targets = new Set<string>();
  // TWO WAYS THIS FILE CAN FAIL TO BE SCANNED, both fail-closed to the same code:
  //   - `scanImportAllowlist` RETURNS a `SourceStreamTruncatedError` when the token stream does
  //     not cover the source (`lexer.ts`'s completeness invariant). Controlled code, reported
  //     as a value — no `try` involved (task-14 review round 2, M6).
  //   - the ENGINE throws: `./jsx`'s reader is recursive descent, and past
  //     `MAX_JSX_NESTING_DEPTH` it raises `JsxNestingTooDeepError` (task 3) — or, for a shape
  //     that reaches the JS stack limit first, a `RangeError`. That is the one UNCONTROLLED
  //     boundary in this module, and the only thing `errore.try` is here for.
  const scanned = errore.try({
    try: () =>
      scanImportAllowlist(source, {
        from,
        has: input.has,
        isScanned: (relPath) => {
          targets.add(relPath);
          return isTrustedTarget(input, relPath) && !isUnscannable(relPath);
        },
        syntax: parsesJsx(from),
      }),
    catch: (cause) => new TreeFileUnscannableError({ file: from, cause }),
  });
  return { outcome: scanned, targets };
}

/** Shape one unscannable file's fail-closed diagnostic. Unchanged in substance — lifted out of
 * `scanTreeImports`'s old body so both call sites in the rewrite share one wording. */
function unscannableError(
  from: string,
  failure: TreeFileUnscannableError | SourceStreamTruncatedError,
): ImportScanError & { readonly file: string } {
  // A wrapped engine throw carries `cause`; a returned truncation is already the reason.
  const cause = failure.cause;
  const reason =
    cause === undefined
      ? failure.message
      : cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
  return {
    code: "UNSCANNABLE_SOURCE",
    specifier: "",
    message: cause === undefined ? `"${from}": ${reason}` : `${failure.message} — ${reason}`,
    line: 1,
    column: 1,
    file: from,
  };
}

/**
 * Run the AUTHORITATIVE allowlist ({@link scanImportAllowlist}) over every CODE file of a tree,
 * tagging each error with the tree-relative path it came from (design §6, §8 step 4). This is
 * the point of the whole-tree scan, not merely a convenience: a forbidden import in a shared
 * module — `lib/theme.ts`, reached by every page that imports it — compromises every page that
 * reaches it, so it must be caught even when the file is scanned on its own, with no page ever
 * mentioned. `scanTreeImports` does no closure walking and does not care whether any entry
 * actually reaches a given file; it scans every CODE file `input.files` names, unconditionally,
 * which is exactly the property that makes an orphaned shared module's own bad import
 * un-missable — a NON-code file in `input.files` is skipped outright ({@link isCodeFile}),
 * never tokenized as JS/TS.
 *
 * THE CONTRACT (task-12 review — see the plan's red-debt ledger, item 3, and rounds 1-4's own
 * findings): `input.has` is the caller's whole-tree inventory — it is legitimately broader
 * than `input.files`, whose keys are only the files THIS pass was given source text for.
 * `store`'s `listTree` enumerates every file under `design/` regardless of extension, so a
 * real tree legitimately contains `.json`/`.md`/`.svg`/`.avif` files a page may resolve a
 * relative import to (design §6 places no extension restriction on a resolution TARGET, only on
 * the extensionless PROBE) without ever needing their text scanned — {@link isCodeFile} draws
 * that line on whether Bun's loader would EXECUTE the target, not on presence. Only a target
 * the loader executes is held to the stricter "must also be a key in `files`" bar, because only
 * that kind of file could itself hide a further forbidden import this pass never read. A caller
 * that narrows `has` down to exactly `files`'s own keys (Task 11's original, since-revised
 * draft) would turn every legitimate cross-file import of a non-executed tree file into a fatal
 * purely because of its presence in the tree, unrelated to anything wrong with it — the same
 * class of defect as Task 9's byte-comparison, which bricked two user commands by rejecting
 * valid input.
 *
 * WHAT THE CODE BELOW ACTUALLY DOES, stated so the next reader need not re-derive it. `has` is
 * passed through UNCHANGED — the resolver is answered honestly about what exists, so it resolves
 * to the file the loader will really run. {@link isTrustedTarget} is then asked ONCE, about that
 * resolved path, and a target the loader EXECUTES but `files` does not hold is reported
 * `UNSCANNED_IMPORT` (task-11 review's Important 2 hazard stays fatal for every extension in
 * {@link EXECUTED_AS_CODE_EXTENSIONS}, matched case-insensitively, and for dotfiles and
 * extensionless names). Nothing else is refused: a target the loader never executes needs no
 * source, and a specifier that does not resolve at all is still the resolver's own
 * `UNRESOLVED_IMPORT`, unchanged.
 *
 * That is a change of CODE, not only of wording, from task-12b's round 0, which forced
 * `UNRESOLVED_IMPORT` by answering `false` from `has` for a present-but-unscanned file. Two
 * things were wrong with that: the resolver then emitted `no file at "lib/foo"` about a file
 * sitting in the tree, and — because it reads that `false` as licence to try the NEXT probe
 * candidate — a scanned sibling could satisfy an import the loader would serve from the unscanned
 * file. See {@link isTrustedTarget} for the measurement.
 *
 * `runTreeImports` (`gate/model/gate.ts`) is the caller this was written for: `has` is backed by
 * the whole-tree `treePaths`, `files` by whatever text this particular turn's Gate run actually
 * holds.
 */
export function scanTreeImports(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly has: (relPath: string) => boolean;
}): readonly (ImportScanError & { readonly file: string })[] {
  // PHASE 1 — scan every code file once, with today's trust rule, recording which targets each
  // file's scan resolved to.
  const scans = new Map<string, FileScanV1>();
  for (const [from, source] of input.files) {
    if (!isCodeFile(from)) continue;
    scans.set(
      from,
      scanOne(input, from, source, () => false),
    );
  }

  // PHASE 2 — a file whose OWN scan failed read nothing, so it can vouch for nothing. Any file
  // that resolved an import INTO one is re-judged with that knowledge; nothing else is touched.
  //
  // WHY NOT JUST MASK THE TRUST PREDICATE IN ONE PASS: the set of unscannable files is not
  // known until the pass is over, and a file may be scanned before the file it imports. A
  // single pass would therefore trust whatever it happened to reach first — order-dependent
  // security, which is worse than the gap it replaces.
  const unscannable = new Set(
    [...scans].filter(([, scan]) => scan.outcome instanceof Error).map(([from]) => from),
  );
  const errors: (ImportScanError & { readonly file: string })[] = [];
  for (const [from, scan] of scans) {
    const tainted =
      !(scan.outcome instanceof Error) &&
      [...scan.targets].some((target) => unscannable.has(target));
    const final = tainted
      ? scanOne(input, from, input.files.get(from) ?? "", (target) => unscannable.has(target))
      : scan;
    if (final.outcome instanceof Error) {
      errors.push(unscannableError(from, final.outcome));
      continue;
    }
    for (const error of final.outcome) errors.push({ ...error, file: from });
  }
  return errors;
}

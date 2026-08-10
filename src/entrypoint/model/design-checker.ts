import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

import type { DesignCheckInputV1, DesignCheckReportV1, DesignCheckerPort } from "agent";
import type { GateErrorV1, GateRunner, GateWarningV1 } from "core/ports";
import {
  DESIGN_DIRNAME,
  PAGES_MANIFEST_RELPATH,
  computeSourceHash,
  computeTreeRevision,
  createDesignTreeInventory,
} from "entities/design-tree";
import type { DesignFileEntryV1 } from "entities/design-tree";
// IMPORTED, NEVER RE-SPELLED: `gate` owns this code, and a local literal is exactly how the memo
// guard below would go silently dead after a rename there. See that constant's own doc.
import { TYPE_CHECK_UNAVAILABLE_CODE } from "gate";
import { log } from "infrastructure/debug-log";

/**
 * THE COMPOSITION ROOT'S ANSWER TO `agent`'s `DesignCheckerPort` (spec WP-10, Task 12).
 *
 * `agent` declares the port it consumes (`agent/checks/types.ts`) rather than importing one: no
 * part of `agent` imports `gate`, and `agent/checks` — shared tier — imports no `core` either, so
 * `core/ports/gate-runner.ts` is equally out of reach from there. `gate` owns the real check but
 * knows nothing about agents. This file is the only place that can see both, which is exactly
 * what a composition root is for — the same shape `buildGateRunner` (`./create-shell.ts`) already
 * uses to hand `core` a `GateRunner` without `core` ever importing `gate`.
 *
 * WHICH STAGES RUN, AND WHY NOT THE OTHERS. `runManifestSlice` then `runTree`: the manifest
 * slice, the flat import allowlist, every entry's closure resolution, the import-graph warnings,
 * the whole-tree determinism/`silencing-any` lints, and ONE `tsc` program over the whole tree.
 * The per-page pipeline (`GateRunner.runPage`) is deliberately NOT run, for two independent
 * reasons and neither is economy for its own sake:
 *
 *  - its smoke stage spawns a HOST CHILD PROCESS PER PAGE (design §8 step 8 calls that the
 *    Gate's real cost), which is precisely what a check the agent may call several times inside
 *    one attempt must not pay; and
 *  - its per-page determinism lints re-report findings the whole-tree pass already produced for
 *    the same entry file — the collision `core/turns/model/validation.ts`'s `dedupeWarnings`
 *    exists to collapse. Reproducing that dedupe rule here would be a second, drifting copy of a
 *    subtle key, and NOT reproducing it would hand the agent every such finding twice.
 *
 * The consequence is a real gap — the page contract and the smoke render are unchecked — and it
 * is stated to the agent verbatim on every clean answer (`agent/checks/model/render.ts`'s
 * `CLEAN_SCOPE_NOTE`), never left to be discovered by a rejection.
 *
 * == THIS CHECK BLOCKS THE WHOLE PROCESS WHILE IT RUNS. MEASURED, NOT ESTIMATED. ==
 *
 * Every stage here is SYNCHRONOUS — {@link readTreeFiles}'s `readdirSync`/`readFileSync`, and
 * then `gate/model/type-check.ts`'s `new API(...)` + `api.updateSnapshot`, which is
 * `typescript/unstable/sync` driving the Go-backed compiler on the calling thread. The `async`
 * signatures on this port and on `GateRunner` are shape, not concurrency: nothing here yields to
 * the event loop, so the UI, the Kernel, and the turn's own live event stream are all frozen for
 * the duration.
 *
 * Measured 2026-08-09 on `examples/clock` (5 pages, 2 shared modules, 8 files, 30 KB), and on
 * the same tree scaled to 25 pages (28 files, 144 KB), by starting a 10 ms `setInterval` and
 * counting how many times it fired DURING the call:
 *
 * | tree                     | first call in a process | later calls | 10 ms ticks during it  |
 * | ------------------------ | ----------------------- | ----------- | ---------------------- |
 * | examples/clock (8 files) | 140-330 ms              | 88-101 ms   | **0** (expected ~9-32) |
 * | 25 pages (28 files)      | 188 ms                  | 158 ms      | **0** (expected ~15-18)|
 *
 * ZERO ticks in every run: the loop is not merely slow, it is starved. One call is therefore a
 * ~0.1-0.35 s freeze of the entire app (the widest single gap observed spanning a call was
 * 342 ms), growing sub-linearly with tree size — NOT the "few seconds" an earlier draft of the
 * tool description guessed at. Every figure quoted elsewhere — the tool description, the system
 * prompt, the flow doc — is this same 0.1-0.35 s range, so no reader meets two numbers.
 *
 * WHY THAT IS ACCEPTED RATHER THAN FIXED HERE. Before this task the same cost was paid once per
 * attempt, by `core/turns/model/validation.ts`, on this same thread — this tool changes how OFTEN
 * it is paid, not whether it blocks. Moving the compiler off-thread is a change to `gate`'s own
 * stage that would affect the turn's validation path too, and is not a tool's to make. What IS
 * done here: the repeat case is capped by the content-keyed memo in
 * {@link createGateDesignChecker}, and the cost is stated everywhere a reader would look for it —
 * this comment, the blocking call site below, the tool's own description
 * (`agent/claude/tools/model/check-design-tool.ts`), the system prompt's `SELF_CHECK` paragraph,
 * and `docs/architecture/flows/generation-turn.md` step 3a.
 *
 * LIVE, NEVER STALE. Every call re-walks `<workspace>/design` off the disk and re-hashes it. The
 * tool exists so the agent can edit, check, and edit again inside one attempt; an answer served
 * from anything but the current bytes would report code the agent already fixed. See the memo's
 * own comment for why caching on those exact bytes does not weaken that.
 */

/** The design tree could not be read at all — a check that did not happen, never a clean pass. */
export class DesignTreeUnreadableError extends errore.createTaggedError({
  name: "DesignTreeUnreadableError",
  message: "the design tree at $treeRoot could not be read: $reason",
}) {}

/** One tree read: every file's text keyed by tree-relative path, plus the `(relPath, sha256)`
 *  inventory used to fingerprint it. Both come from the SAME single read of each file. */
interface TreeReadV1 {
  readonly files: ReadonlyMap<string, string>;
  readonly entries: readonly DesignFileEntryV1[];
}

/**
 * Every file under `treeRoot`, keyed by its TREE-relative POSIX path — the same vocabulary
 * `GateRunner.runTree` takes and `GateError.file` echoes back.
 *
 * NO FILTER OF THIS RING'S OWN, deliberately, for the reason
 * `RunTurnValidationInputV1.files` states at length: any "which files are code" predicate here
 * would be a second, independently derived copy of `gate/model/tree-scan.ts`'s measured
 * `isCodeFile`, and the only filter that cannot drift from it is no filter at all. A `.png`'s
 * bytes cost a decode and are then skipped by the scan itself.
 *
 * SYMLINKS AND SIZE, and why this needs no `SafeProjectFs`-style guard of its own. This walk
 * reads a TURN WORKSPACE, not user-supplied paths: `store/sandbox/model/staging-store.ts` built
 * it by copying the canonical tree through `checkManagedLeaf`, which refuses a hardlinked or
 * otherwise non-plain source, so a symlink cannot be staged into it in the first place. Even if
 * one appeared, `readdirSync({recursive: true})` does not descend into symlinked directories and
 * the `isFile()` guard below skips a symlinked file, so nothing outside the tree is ever opened
 * — and a file skipped here is simply absent from `files`, which makes any closure reaching it
 * unprovable and the check REJECT rather than pass. Fail-closed, by construction. There is no
 * size cap because there is nothing to cap against: these are the same bytes the turn's own
 * validation already reads whole (measured affordable there at 2.3 MB across 128 files).
 */
function readTreeFiles(treeRoot: string): DesignTreeUnreadableError | TreeReadV1 {
  const dirents = errore.try({
    try: () => fs.readdirSync(treeRoot, { recursive: true, withFileTypes: true }),
    catch: (cause) =>
      new DesignTreeUnreadableError({
        treeRoot,
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  if (dirents instanceof Error) return dirents;

  const files = new Map<string, string>();
  const entries: DesignFileEntryV1[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const absPath = path.join(dirent.parentPath, dirent.name);
    const relPath = path.relative(treeRoot, absPath).split(path.sep).join("/");
    // Read ONCE, as bytes, and derive both forms from it: the text `runTree` scans and the hash
    // the memo fingerprints. Reading twice would double the I/O and could observe two different
    // versions of the same file mid-edit.
    const bytes = errore.try({
      try: () => fs.readFileSync(absPath),
      catch: (cause) =>
        new DesignTreeUnreadableError({
          treeRoot,
          reason: `${relPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    // A file the walk listed and the read then refused is a genuine failure of THIS check, not a
    // diagnostic about the design: reporting it as "no problems" would be the lie this whole
    // module is built to avoid, and reporting it as a Gate error would blame the page for a
    // filesystem fault.
    if (bytes instanceof Error) return bytes;
    files.set(relPath, bytes.toString("utf8"));
    entries.push({ relPath, sha256: computeSourceHash(bytes) });
  }
  return { files, entries };
}

/**
 * A fingerprint of exactly the bytes this read saw, or `null` when one cannot be computed.
 *
 * `computeTreeRevision` is the repo's own canonical "are these the same tree" fold — reused
 * rather than hand-rolled so this key cannot disagree with the one `entities/design-tree` uses
 * everywhere else. A `DuplicateInventoryPathError` is impossible from a filesystem walk (paths
 * are unique by construction), so `null` here is defensive only, and its handling is to SKIP the
 * memo entirely — never to reuse a previous answer under an unknown key.
 */
function fingerprintTree(read: TreeReadV1): string | null {
  const inventory = createDesignTreeInventory(read.entries);
  if (inventory instanceof Error) {
    log.warn(
      `entrypoint/design-checker: could not fingerprint the tree (${inventory.message}); running the check uncached`,
    );
    return null;
  }
  return computeTreeRevision(inventory);
}

/** `undefined` -> absent, so the agent-side redraw's optional fields keep their own meaning
 *  (absent is "about the tree", never "unknown"). */
function toCheckError(error: GateErrorV1): DesignCheckReportV1["errors"][number] {
  return {
    kind: error.kind,
    code: error.code,
    message: error.message,
    ...(error.file !== undefined ? { file: error.file } : {}),
    ...(error.line !== undefined ? { line: error.line } : {}),
    ...(error.column !== undefined ? { column: error.column } : {}),
    ...(error.blockedPages !== undefined ? { blockedPages: error.blockedPages } : {}),
  };
}

function toCheckWarning(warning: GateWarningV1): DesignCheckReportV1["warnings"][number] {
  return {
    kind: warning.kind,
    message: warning.message,
    ...(warning.file !== undefined ? { file: warning.file } : {}),
    ...(warning.line !== undefined ? { line: warning.line } : {}),
    ...(warning.column !== undefined ? { column: warning.column } : {}),
    ...(warning.blockedPages !== undefined ? { blockedPages: warning.blockedPages } : {}),
  };
}

/** Wires the production `GateRunner` into the `DesignCheckerPort` the agent's `check_design`
 *  tool consumes. See this file's header for which Gate stages run, which deliberately do not,
 *  and the measured cost of one call. */
export function createGateDesignChecker(gateRunner: GateRunner): DesignCheckerPort {
  /**
   * THE LAST ANSWER, KEYED ON THE EXACT TREE BYTES THAT PRODUCED IT — a memo of size one.
   *
   * WHAT IT IS FOR: the system prompt asks the agent to check after each round of edits, and a
   * model can legitimately emit two `check_design` calls in one message. Without this, two calls
   * with no edit between them freeze the app twice (~0.1-0.35 s each, measured in this file's
   * header) to compute the identical answer.
   *
   * WHY IT CANNOT SERVE A STALE ANSWER, which is the property this whole tool lives or dies by.
   * It is NOT a time-based debounce — a debounce would have to ASSUME nothing changed, and the
   * agent's own `Write` runs in the CLI child process where this code cannot observe it. This
   * caches on CONTENT: every call still re-walks and re-reads the whole tree from disk, and the
   * cached report is reused only when the fold over every `(relPath, sha256)` is IDENTICAL. The
   * check is a pure function of those bytes (`runManifestSlice` + `runTree` read no clock, no
   * randomness, and no state outside `files`), so a hit returns exactly what a re-run would
   * compute. One edited byte changes the fingerprint and the check runs again.
   *
   * So the work skipped is the expensive part only — the `tsc` program — while the read the
   * freshness guarantee depends on is never skipped. Keyed on `workspacePath` as well as the
   * fingerprint: two workspaces holding identical bytes would also produce identical reports, but
   * making that reasoning unnecessary costs nothing.
   *
   * ONE RESULT IS NEVER STORED, AND IT IS THE EXCEPTION THAT PROVES THE RULE ABOVE. "Pure
   * function of the bytes" holds for every diagnostic except {@link TYPE_CHECK_UNAVAILABLE_CODE}:
   * that fatal reports whether the COMPILER is up, not anything about the tree. Cached, it would
   * stick until the agent happened to edit a file — so the natural recovery from a transient
   * compiler hiccup (call `check_design` again, unchanged, to see whether it was transient) would
   * be answered with the very failure it is trying to retry. So a report carrying it is returned
   * and discarded, and the next call attempts the compiler again.
   */
  let memo: { readonly key: string; readonly report: DesignCheckReportV1 } | null = null;

  return {
    async check(input: DesignCheckInputV1): Promise<Error | DesignCheckReportV1> {
      const treeRoot = path.join(input.workspacePath, DESIGN_DIRNAME);
      const read = readTreeFiles(treeRoot);
      if (read instanceof Error) return read;

      const fingerprint = fingerprintTree(read);
      const key = fingerprint === null ? null : `${input.workspacePath} ${fingerprint}`;
      if (key !== null && memo !== null && memo.key === key) return memo.report;

      const treePaths = [...read.files.keys()];
      // An absent manifest is not a crash here — `checkManifestSlice` produces the honest
      // manifest diagnostic for empty text, which is a far more useful answer than "the check
      // could not run" for a tree whose `pages.json` the agent has yet to write.
      const manifestText = read.files.get(PAGES_MANIFEST_RELPATH) ?? "";

      const slice = await gateRunner.runManifestSlice({ manifestText, treePaths });
      // Design §8's own ordering, and `runTree` runs UNCONDITIONALLY — even on an undecodable
      // manifest — for the same reason `core/turns/model/validation.ts` runs it unconditionally:
      // the flat allowlist scan covers every code file regardless of which pages exist, so
      // skipping it on a manifest typo would hide every import violation behind that typo.
      //
      // THIS IS THE BLOCKING CALL (see this file's header for the measurements): `runTree`'s type
      // stage drives `typescript/unstable/sync` on THIS thread, so the whole process — UI, Kernel,
      // and the turn's own live event stream — makes no progress until it returns. Measured at
      // ZERO ticks of a 10 ms interval across every run, i.e. a genuine freeze, not a slowdown.
      const tree = await gateRunner.runTree({
        files: read.files,
        treePaths,
        pages: slice.slice?.pages ?? [],
      });

      const report: DesignCheckReportV1 = {
        errors: [...slice.errors, ...tree.errors].map(toCheckError),
        warnings: tree.warnings.map(toCheckWarning),
      };
      // See the memo's own doc: a compiler-unavailability fatal is not a fact about these bytes,
      // so storing it would answer the agent's retry with the failure it is retrying.
      const compilerWasUnavailable = tree.errors.some(
        (error) => error.code === TYPE_CHECK_UNAVAILABLE_CODE,
      );
      if (key !== null && !compilerWasUnavailable) memo = { key, report };
      return report;
    },
  };
}

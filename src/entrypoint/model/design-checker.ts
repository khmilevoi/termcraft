import fs from "node:fs";
import path from "node:path";

import * as errore from "errore";

import type { DesignCheckInputV1, DesignCheckReportV1, DesignCheckerPort } from "agent";
import type { GateErrorV1, GateRunner, GateWarningV1 } from "core/ports";
import { DESIGN_DIRNAME, PAGES_MANIFEST_RELPATH } from "entities/design-tree";

/**
 * THE COMPOSITION ROOT'S ANSWER TO `agent`'s `DesignCheckerPort` (spec WP-10, Task 12).
 *
 * `agent` declares the port it consumes (`agent/checks/types.ts`) and may import neither `gate`
 * nor `core`; `gate` owns the real check but knows nothing about agents. This file is the only
 * place that can see both, which is exactly what a composition root is for — the same shape
 * `buildGateRunner` (`./create-shell.ts`) already uses to hand `core` a `GateRunner` without
 * `core` ever importing `gate`.
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
 * LIVE, NEVER CACHED. Every call re-walks `<workspace>/design` off the disk. The tool exists so
 * the agent can edit, check, and edit again inside one attempt; a memoized tree would answer the
 * second call with the code the first call complained about.
 */

/** The design tree could not be read at all — a check that did not happen, never a clean pass. */
export class DesignTreeUnreadableError extends errore.createTaggedError({
  name: "DesignTreeUnreadableError",
  message: "the design tree at $treeRoot could not be read: $reason",
}) {}

/**
 * Every file under `treeRoot`, keyed by its TREE-relative POSIX path — the same vocabulary
 * `GateRunner.runTree` takes and `GateError.file` echoes back.
 *
 * NO FILTER OF THIS RING'S OWN, deliberately, for the reason
 * `RunTurnValidationInputV1.files` states at length: any "which files are code" predicate here
 * would be a second, independently derived copy of `gate/model/tree-scan.ts`'s measured
 * `isCodeFile`, and the only filter that cannot drift from it is no filter at all. A `.png`'s
 * bytes cost a decode and are then skipped by the scan itself.
 */
function readTreeFiles(treeRoot: string): DesignTreeUnreadableError | Map<string, string> {
  const entries = errore.try({
    try: () => fs.readdirSync(treeRoot, { recursive: true, withFileTypes: true }),
    catch: (cause) =>
      new DesignTreeUnreadableError({
        treeRoot,
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  if (entries instanceof Error) return entries;

  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absPath = path.join(entry.parentPath, entry.name);
    const relPath = path.relative(treeRoot, absPath).split(path.sep).join("/");
    const text = errore.try({
      try: () => fs.readFileSync(absPath, "utf8"),
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
    if (text instanceof Error) return text;
    files.set(relPath, text);
  }
  return files;
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
 *  tool consumes. See this file's header for which Gate stages run and which deliberately do not. */
export function createGateDesignChecker(gateRunner: GateRunner): DesignCheckerPort {
  return {
    async check(input: DesignCheckInputV1): Promise<Error | DesignCheckReportV1> {
      const treeRoot = path.join(input.workspacePath, DESIGN_DIRNAME);
      const files = readTreeFiles(treeRoot);
      if (files instanceof Error) return files;

      const treePaths = [...files.keys()];
      // An absent manifest is not a crash here — `checkManifestSlice` produces the honest
      // manifest diagnostic for empty text, which is a far more useful answer than "the check
      // could not run" for a tree whose `pages.json` the agent has yet to write.
      const manifestText = files.get(PAGES_MANIFEST_RELPATH) ?? "";

      const slice = await gateRunner.runManifestSlice({ manifestText, treePaths });
      // Design §8's own ordering, and `runTree` runs UNCONDITIONALLY — even on an undecodable
      // manifest — for the same reason `core/turns/model/validation.ts` runs it unconditionally:
      // the flat allowlist scan covers every code file regardless of which pages exist, so
      // skipping it on a manifest typo would hide every import violation behind that typo.
      const tree = await gateRunner.runTree({
        files,
        treePaths,
        pages: slice.slice?.pages ?? [],
      });

      return {
        errors: [...slice.errors, ...tree.errors].map(toCheckError),
        warnings: tree.warnings.map(toCheckWarning),
      };
    },
  };
}

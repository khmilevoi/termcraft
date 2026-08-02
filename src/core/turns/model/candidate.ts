import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import type {
  StagedFileV1,
  StagedTurnReadSetV1,
  StagingService,
  TurnWorkspaceV1,
} from "core/ports";
import type { CommandRejectionCode, FailureDtoV1, Sha256Hex } from "core/protocol";
import {
  DESIGN_DIRNAME,
  PAGES_MANIFEST_RELPATH,
  computeClosureHash,
  inventorySha256,
} from "entities/design-tree";
import type { DesignFileEntryV1, DesignTreeInventoryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

/**
 * `kernel.turn.candidateCaptured` — `snapshotting -> validating` (kernel-command-contract
 * §7.2 line 237; §12.2 item 6).
 *
 * ENTRY POINT, NOT THE EDGE INTO IT: matching `finalize.ts`'s / `terminalize.ts`'s
 * documented pattern, this file assumes the machine is ALREADY `snapshotting` — reached via
 * `beginSnapshot`, which belongs to whichever caller inspected `attempt.ts`'s own
 * `{kind:"completed", ...}` outcome (this file's own header, mirrored from theirs).
 *
 * §12.2 item 6, verbatim: "Gate receives an immutable candidate copied by the safe
 * filesystem intake path, NOT the agent's writable workspace." `StagingService
 * .snapshotToCandidate` IS that intake path (its own doc: "copy the finished workspace into
 * an immutable candidate OUTSIDE the workspace ... a hostile workspace passes zero bytes to
 * any consumer on a validation failure") — this module never reads the workspace itself.
 *
 * THE FILE DIFF NEVER TOUCHES CONTENT (design §7). `StagedFileV1`/`DesignFileEntryV1` carry
 * only `relPath`/`sha256`/`size` — no bytes — matching projections §9: "The Kernel computes
 * each initial source hash while copying. It does not make a second full source snapshot
 * merely for diffing." So `fileChanges` below is a HASH-and-PATH-SET comparison against the
 * turn's own send-time read set (`workspace.readSet.designFiles`, `null` marking an
 * expected-absent target) — never a byte read of any individual design file.
 *
 * `manifestText` IS the one deliberate exception, not an oversight: Gate's
 * `runManifestSlice`/schema validation needs the manifest's actual bytes, not merely its
 * hash, and nothing else in `core/turns` has ever read a candidate file's content back
 * (`StagingService.readCandidateFile`'s own doc names this precise gap, "Gap 3" —
 * `TurnCandidateV1` used to carry only hashes/sizes, leaving no way to reconstruct Gate's
 * `manifestText` from a frozen candidate at all). Reading it once, here, at freeze time —
 * this function is already async — means every downstream consumer (Gate's manifest-slice
 * check, a caller building `treePaths`) reads it off the candidate directly, never
 * re-deriving or re-fetching it a second time.
 */

export interface FreezeTurnCandidateDeps {
  readonly machine: StateMachine<TurnState, TurnAction>;
  readonly staging: StagingService;
}

export interface FreezeTurnCandidateInputV1 {
  readonly workspace: TurnWorkspaceV1;
}

export type DesignFileChangeKindV1 = "added" | "modified" | "removed";

/** One design-tree file whose candidate state differs from the turn's send-time read set. Unchanged files are simply absent from the diff — see `diffTreeInventory`. */
export interface DesignFileChangeV1 {
  readonly relPath: string;
  readonly change: DesignFileChangeKindV1;
  /** `null` only for `"removed"` — the file no longer exists in the candidate. */
  readonly sha256: Sha256Hex | null;
  readonly size: number | null;
}

export interface TurnCandidateV1 {
  readonly root: string;
  readonly totalBytes: number;
  /** The frozen candidate's own `design/pages.json`, decoded — see this file's header. */
  readonly manifestText: string;
  /** The candidate's design-tree files, TREE-relative (the `design/` prefix stripped) — Gate's `runManifestSlice`/`runTreeImports` `treePaths` input. */
  readonly treeFiles: readonly StagedFileV1[];
  readonly fileChanges: readonly DesignFileChangeV1[];
}

export type FreezeTurnCandidateResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "captured"; readonly candidate: TurnCandidateV1 };

/** `design/pages.json`, project-relative — the frozen candidate's own manifest file (matches `store`'s staging convention: the whole tree is staged under `design/`). */
const MANIFEST_PROJECT_RELPATH = `${DESIGN_DIRNAME}/${PAGES_MANIFEST_RELPATH}`;

const DESIGN_TREE_FILE_PREFIX = `${DESIGN_DIRNAME}/`;

/**
 * A frozen candidate mirrors the whole turn workspace — `design/**`, `RUNTIME.md`, runtime
 * type declarations — never just the design tree. Narrows `candidate.files` down to the
 * design-tree slice and strips the `design/` prefix, so the result speaks the SAME
 * tree-relative vocabulary `StagedTurnReadSetV1.designFiles`/Gate's `treePaths` already do.
 * A non-design file (`RUNTIME.md`, a runtime `.d.ts`) is simply not part of the design tree's
 * own diff and is excluded here, not reported as a spurious "added" design file.
 */
function toDesignTreeFiles(files: readonly StagedFileV1[]): readonly StagedFileV1[] {
  const result: StagedFileV1[] = [];
  for (const file of files) {
    if (!file.relPath.startsWith(DESIGN_TREE_FILE_PREFIX)) continue;
    result.push({ ...file, relPath: file.relPath.slice(DESIGN_TREE_FILE_PREFIX.length) });
  }
  return result;
}

/**
 * The turn's send-time design-tree inventory, built from its own staged read set. An entry
 * whose `snapshot` is `null` (staging's own "expected-absent target" marker) is simply
 * omitted — there is nothing to carry a hash for, and omitting it is exactly what makes such
 * a target read back as `"added"` once `diffTreeInventory` sees it appear in the candidate.
 */
function toBeforeInventory(designFiles: StagedTurnReadSetV1["designFiles"]): DesignTreeInventoryV1 {
  const entries: DesignFileEntryV1[] = [];
  for (const file of designFiles) {
    if (file.snapshot === null) continue;
    entries.push({ relPath: file.relPath, sha256: file.snapshot.sha256 });
  }
  return { files: entries };
}

/**
 * Diffs a design-tree inventory (the turn's send-time baseline) against a candidate's
 * staged design-tree files — total over the UNION of both sides: a path absent from
 * `before` but present in `files` is still reported (`"added"`), never silently dropped for
 * lacking a prior baseline, and the reverse (`"removed"`) holds symmetrically.
 */
export function diffTreeInventory(
  before: DesignTreeInventoryV1,
  files: readonly StagedFileV1[],
): { readonly fileChanges: readonly DesignFileChangeV1[] } {
  const sha256Of = inventorySha256(before);
  const afterByPath = new Map(files.map((file) => [file.relPath, file]));
  const allPaths = new Set<string>([
    ...before.files.map((file) => file.relPath),
    ...afterByPath.keys(),
  ]);

  const fileChanges: DesignFileChangeV1[] = [];
  for (const relPath of allPaths) {
    const beforeHash = sha256Of(relPath);
    const after = afterByPath.get(relPath) ?? null;

    if (after === null) {
      // Only reachable when this path came from `before` (it is a member of `allPaths`
      // either way), so it genuinely existed on that side.
      fileChanges.push({ relPath, change: "removed", sha256: null, size: null });
      continue;
    }
    if (beforeHash !== null && beforeHash === after.sha256) continue; // unchanged

    fileChanges.push({
      relPath,
      change: beforeHash === null ? "added" : "modified",
      sha256: after.sha256,
      size: after.size,
    });
  }

  return { fileChanges };
}

/**
 * The slugs whose CLOSURE hash differs between the turn's send-time read set and the frozen
 * candidate (design §7). This is what `changedPages` means once modules can be shared: an
 * edit to `lib/theme.ts` changes what every page reaching it renders while no page entry
 * file's own bytes move, so a diff keyed on the entry's file hash would report "nothing
 * changed" for every consumer in §7's table.
 *
 * A slug whose closure hash cannot be computed on EITHER side (a closure file absent from
 * that inventory) counts as changed. That is the honest answer: "I cannot prove it is
 * unchanged" must never be reported as "unchanged".
 *
 * `closures` arrives through the `GateRunner` port's `runTreeImports` result (design §7's
 * whole-tree scan is what resolves each entry's transitive file set) — never computed here:
 * `core` may not import `gate`, and this function has no `edgesOf`/specifier resolver of its
 * own. Wiring a real caller is Task 14's job (`.superpowers/sdd/2026-07-28-design-tree-
 * canonical-source/red-debt.md`'s own SECURITY-CRITICAL entry); this function is a pure,
 * independently testable primitive over whatever closures a caller hands it.
 */
export function selectChangedPages(input: {
  readonly closures: readonly { readonly slug: PageSlug; readonly files: readonly string[] }[];
  readonly beforeInventory: DesignTreeInventoryV1;
  readonly afterInventory: DesignTreeInventoryV1;
}): readonly PageSlug[] {
  const before = inventorySha256(input.beforeInventory);
  const after = inventorySha256(input.afterInventory);
  return input.closures
    .filter((closure) => {
      const beforeHash = computeClosureHash({ files: closure.files, sha256Of: before });
      const afterHash = computeClosureHash({ files: closure.files, sha256Of: after });
      return beforeHash === null || afterHash === null || beforeHash !== afterHash;
    })
    .map((closure) => closure.slug);
}

/**
 * Freezes the finished writable workspace into an immutable, Gate-facing candidate: snapshots
 * it, reads its manifest text back, and diffs its design-tree files against the turn's
 * send-time read set.
 */
export async function freezeTurnCandidate(
  deps: FreezeTurnCandidateDeps,
  input: FreezeTurnCandidateInputV1,
): Promise<FreezeTurnCandidateResultV1> {
  const candidate = await wrap(deps.staging.snapshotToCandidate(input.workspace));
  if ("code" in candidate) return { kind: "failed", failure: candidate };

  const captured = deps.machine.apply("candidateCaptured");
  if (captured.kind === "illegal") return { kind: "illegal", code: captured.code };

  const manifestBytes = await wrap(
    deps.staging.readCandidateFile(candidate.root, MANIFEST_PROJECT_RELPATH),
  );
  if ("code" in manifestBytes) return { kind: "failed", failure: manifestBytes };

  const beforeInventory = toBeforeInventory(input.workspace.readSet.designFiles);
  const treeFiles = toDesignTreeFiles(candidate.files);
  const { fileChanges } = diffTreeInventory(beforeInventory, treeFiles);

  return {
    kind: "captured",
    candidate: {
      root: candidate.root,
      totalBytes: candidate.totalBytes,
      manifestText: new TextDecoder().decode(manifestBytes),
      treeFiles,
      fileChanges,
    },
  };
}

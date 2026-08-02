import { wrap } from "@reatom/core";

import type { StateMachine, TurnAction, TurnState } from "core/machines";
import type {
  CandidatePageSetV1,
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
 * hash. `StagingService.readCandidateFile`'s own doc names three things `TurnCandidateV1`
 * used to have no way to reconstruct from a frozen candidate ("Gap 3") — the manifest text,
 * each page's own `source` for `runPage`, and finalize's changed-file bytes. Only the FIRST
 * is closed here: `manifestText`, read once at freeze time (this function is already async),
 * so a caller building Gate's manifest-slice input reads it off the candidate directly rather
 * than re-fetching it. The other two remain open — reading arbitrary page/changed-file bytes
 * back is a per-caller concern (`buildValidationInput`/`buildFinalizeInput`), not something
 * this module can honestly do once, up front, without knowing which files a caller will ask
 * for.
 *
 * AN ABSENT `design/pages.json` IS AN HONEST ABSENCE, NEVER A FAILED READ (task-13 review
 * round 1, Important I2). `readCandidateFile`'s own contract requires `relPath` to be one of
 * the candidate's own `StagedFileV1.relPath` entries (`core/ports/staging.ts`) — calling it
 * for a path the candidate does not list is out of contract by construction, not merely
 * unlikely. So this module checks `candidate.files` FIRST: when the manifest is not listed,
 * `manifestText` is the honest empty string and `readCandidateFile` is never called at all.
 * An empty `manifestText` then fails Gate's own manifest-slice check exactly like any other
 * malformed manifest — a normal, RETRYABLE Gate rejection the agent can act on — never the
 * non-retryable `PERSISTENCE_FAILED` infrastructure death an out-of-contract read would
 * otherwise produce (a manifest problem must reach the same retry loop every OTHER Gate
 * rejection does). A read that fails for a manifest the candidate DOES list is still a
 * genuine failure (`{kind:"failed"}`) — the port's own contract guarantees success there, so
 * a failure is abnormal, not an expected shape.
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
 *
 * NO DUPLICATE-`relPath` DEFENSE HERE (task-13 review round 1, Minor M3 — flagged, not fixed):
 * a duplicate silently keeps the LAST occurrence, unlike `read-set.ts`'s `toFinalizeReadSet`
 * (`toMap`), which REFUSES the identical shape of duplicate on the very same
 * `StagedTurnReadSetV1.designFiles` array. CHECKED, NOT MERELY ASSUMED, that this asymmetry has
 * no real producer to reach it today: `grep -rn "designFiles:" src --include=*.ts | grep -v
 * test` finds no production code anywhere in this repository that constructs a
 * `StagedTurnReadSetV1.designFiles` array literal — the real assembly (a `listTree()` walk
 * over `design/`, keyed by each file's own real path, which cannot enumerate the same path
 * twice) is explicitly Task 14's own upcoming work (`task-14-brief.md`, Step 1: "producing both
 * `treeFiles` and `readSet.designFiles`"). So today only a hand-built TEST fixture can ever
 * construct a duplicate here, never a real caller. Whichever task wires that real producer
 * (Task 14) should either confirm a filesystem walk keeps this unreachable for real, or give
 * this function the identical `ReadSetTranslationError`-shaped refusal `toMap` already has —
 * this comment is the flag that the decision is still open, not a claim it is already safe in
 * production.
 */
export function readSetTreeInventory(
  designFiles: StagedTurnReadSetV1["designFiles"],
): DesignTreeInventoryV1 {
  const entries: DesignFileEntryV1[] = [];
  for (const file of designFiles) {
    if (file.snapshot === null) continue;
    entries.push({ relPath: file.relPath, sha256: file.snapshot.sha256 });
  }
  return { files: entries };
}

/**
 * The CANDIDATE side of the same comparison — a `DesignTreeInventoryV1` over
 * {@link TurnCandidateV1.treeFiles}, which already speaks tree-relative paths.
 *
 * Exported alongside {@link readSetTreeInventory} (task 14) so `selectChangedPages`' one
 * production caller (`core/kernel/model/handlers/turn.ts`'s `buildFinalizeInput`) builds BOTH
 * sides of the diff from this module rather than open-coding two inventory constructions of
 * its own. Both sides must agree on the same two conventions — tree-relative paths, and
 * "expected-absent means omitted, not a null hash" — and a caller re-deriving either one is
 * how the two sides come to disagree.
 */
export function candidateTreeInventory(treeFiles: readonly StagedFileV1[]): DesignTreeInventoryV1 {
  return { files: treeFiles.map((file) => ({ relPath: file.relPath, sha256: file.sha256 })) };
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
 *
 * DEDUPLICATED BY CONSTRUCTION (task-13 review round 1, Minor M2): `input.closures` is a raw
 * list this function does not control the shape of, and nothing upstream guarantees one slug
 * names at most one closure — a duplicate slug entry would otherwise be filtered and mapped
 * twice, emitting the SAME slug twice into the result array. CORRECTED (task-13 review round
 * 2, Minor M-b): this does NOT double anything downstream — `core/pins/model/
 * turn-resolution.ts`'s `resolveSentPinAppends` runs its own `changedPages` input through a
 * `Set` before filtering `sentPins` against it (verified: feeding it `["a","a"]` produces the
 * SAME single append a plain `["a"]` would), so a duplicate slug here was never a correctness
 * bug there. The real, narrower reason to dedupe here: `readonly PageSlug[]` reads as a SET to
 * any caller that has not read `resolveSentPinAppends`' own defensive dedupe — one that counts
 * `changedPageSlugs.length` as "how many pages changed", or iterates it for a per-page side
 * effect, would silently double-count or double-act on this exact page. Returned through a
 * `Set`, so the result is duplicate-free regardless of what `input.closures` contains.
 */
export function selectChangedPages(input: {
  readonly closures: readonly { readonly slug: PageSlug; readonly files: readonly string[] }[];
  readonly beforeInventory: DesignTreeInventoryV1;
  readonly afterInventory: DesignTreeInventoryV1;
}): readonly PageSlug[] {
  const before = inventorySha256(input.beforeInventory);
  const after = inventorySha256(input.afterInventory);
  const changed = input.closures.filter((closure) => {
    const beforeHash = computeClosureHash({ files: closure.files, sha256Of: before });
    const afterHash = computeClosureHash({ files: closure.files, sha256Of: after });
    return beforeHash === null || afterHash === null || beforeHash !== afterHash;
  });
  return [...new Set(changed.map((closure) => closure.slug))];
}

/**
 * The frozen candidate's own `design/pages.json` bytes, or an honest empty when the manifest
 * is not one of the candidate's OWN listed files — never an out-of-contract
 * `readCandidateFile` call for a path the candidate does not carry (this file's header,
 * "AN ABSENT design/pages.json IS AN HONEST ABSENCE").
 */
async function readManifestBytes(
  staging: StagingService,
  candidate: CandidatePageSetV1,
): Promise<FailureDtoV1 | Uint8Array> {
  const manifestListed = candidate.files.some((file) => file.relPath === MANIFEST_PROJECT_RELPATH);
  if (!manifestListed) return new Uint8Array(0);
  return wrap(staging.readCandidateFile(candidate.root, MANIFEST_PROJECT_RELPATH));
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

  const manifestBytes = await readManifestBytes(deps.staging, candidate);
  if ("code" in manifestBytes) return { kind: "failed", failure: manifestBytes };

  const beforeInventory = readSetTreeInventory(input.workspace.readSet.designFiles);
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

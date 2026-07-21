import { wrap } from "@reatom/core"

import type { StateMachine, TurnAction, TurnState } from "core/machines"
import type {
  ReadSetFileSnapshotV1,
  StagedFileV1,
  StagedTurnReadSetV1,
  StagingService,
  TurnWorkspaceV1,
} from "core/ports"
import type { CommandRejectionCode, FailureDtoV1, Sha256Hex } from "core/protocol"
import type { PageSlug } from "entities/page"

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
 * THE DIFF NEVER TOUCHES CONTENT. `CandidatePageSetV1`/`StagedFileV1` carry only
 * `relPath`/`sha256`/`size` — no bytes — matching projections §9: "The Kernel computes each
 * initial source hash while copying. It does not make a second full source snapshot merely
 * for diffing." So "diff the page inventory" here is a HASH-and-SLUG-SET comparison against
 * the turn's own send-time read set (`workspace.readSet.canonicalPages`, `null` marking an
 * expected-absent target) — never a byte read, and never Gate itself (which the caller runs
 * separately, per-page, over the SAME candidate this module freezes).
 */

export interface FreezeTurnCandidateDeps {
  readonly machine: StateMachine<TurnState, TurnAction>
  readonly staging: StagingService
}

export interface FreezeTurnCandidateInputV1 {
  readonly workspace: TurnWorkspaceV1
}

export type PageInventoryChangeKindV1 = "added" | "modified" | "removed"

/** One page whose candidate state differs from the turn's send-time read set. Unchanged pages are simply absent from the diff — see `diffPageInventory`. */
export interface PageInventoryChangeV1 {
  readonly pageSlug: PageSlug
  readonly change: PageInventoryChangeKindV1
  /** `null` only for `"removed"` — the page no longer exists in the candidate. */
  readonly sha256: Sha256Hex | null
  readonly size: number | null
}

export interface TurnCandidateV1 {
  readonly root: string
  readonly totalBytes: number
  /** The ordered page slugs present in the candidate — Gate's `runManifestSlice` `presentSlugs` input. */
  readonly presentSlugs: readonly PageSlug[]
  readonly changes: readonly PageInventoryChangeV1[]
}

export type FreezeTurnCandidateResultV1 =
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode }
  | { readonly kind: "failed"; readonly failure: FailureDtoV1 }
  | { readonly kind: "captured"; readonly candidate: TurnCandidateV1 }

/** The real staging store's own page-file convention (`store/sandbox/model/staging-store.ts`'s `stageAllFiles`: `pages/${slug}.tsx`). */
const PAGE_FILE_PATTERN = /^pages\/([^/]+)\.tsx$/

function pageSlugFromRelPath(relPath: string): PageSlug | null {
  const match = PAGE_FILE_PATTERN.exec(relPath)
  return match === null ? null : (match[1] as PageSlug)
}

interface FileImage {
  readonly sha256: Sha256Hex
  readonly size: number
}

function toBeforeMap(canonicalPages: StagedTurnReadSetV1["canonicalPages"]): ReadonlyMap<PageSlug, ReadSetFileSnapshotV1 | null> {
  return new Map(canonicalPages.map((entry) => [entry.pageSlug, entry.snapshot]))
}

function toPresentMap(files: readonly StagedFileV1[]): { readonly presentSlugs: readonly PageSlug[]; readonly presentBySlug: ReadonlyMap<PageSlug, FileImage> } {
  const presentSlugs: PageSlug[] = []
  const presentBySlug = new Map<PageSlug, FileImage>()
  for (const file of files) {
    const slug = pageSlugFromRelPath(file.relPath)
    if (slug === null) continue
    presentSlugs.push(slug)
    presentBySlug.set(slug, { sha256: file.sha256, size: file.size })
  }
  return { presentSlugs, presentBySlug }
}

/**
 * Diffs the candidate's page files against the turn's send-time read set. Total over the
 * UNION of both sides — a page absent from the read set but present in the candidate is
 * still reported (`"added"`), never silently dropped for lacking a prior baseline.
 */
function diffPageInventory(
  readSet: StagedTurnReadSetV1,
  files: readonly StagedFileV1[],
): { readonly presentSlugs: readonly PageSlug[]; readonly changes: readonly PageInventoryChangeV1[] } {
  const beforeBySlug = toBeforeMap(readSet.canonicalPages)
  const { presentSlugs, presentBySlug } = toPresentMap(files)

  const allSlugs = new Set<PageSlug>([...beforeBySlug.keys(), ...presentBySlug.keys()])
  const changes: PageInventoryChangeV1[] = []

  for (const pageSlug of allSlugs) {
    const before = beforeBySlug.get(pageSlug) ?? null
    const after = presentBySlug.get(pageSlug) ?? null

    if (after === null) {
      // Only reachable when `before` is non-null (the slug came from one of the two maps),
      // and a `null` `before` paired with a `null` `after` is not a real inventory entry.
      if (before !== null) changes.push({ pageSlug, change: "removed", sha256: null, size: null })
      continue
    }
    if (before !== null && before.sha256 === after.sha256) continue // unchanged

    changes.push({ pageSlug, change: before === null ? "added" : "modified", sha256: after.sha256, size: after.size })
  }

  return { presentSlugs, changes }
}

/**
 * Freezes the finished writable workspace into an immutable, Gate-facing candidate and
 * diffs its page inventory against the turn's send-time read set.
 */
export async function freezeTurnCandidate(
  deps: FreezeTurnCandidateDeps,
  input: FreezeTurnCandidateInputV1,
): Promise<FreezeTurnCandidateResultV1> {
  const candidate = await wrap(deps.staging.snapshotToCandidate(input.workspace))
  if ("code" in candidate) return { kind: "failed", failure: candidate }

  const captured = deps.machine.apply("candidateCaptured")
  if (captured.kind === "illegal") return { kind: "illegal", code: captured.code }

  const { presentSlugs, changes } = diffPageInventory(input.workspace.readSet, candidate.files)

  return {
    kind: "captured",
    candidate: { root: candidate.root, totalBytes: candidate.totalBytes, presentSlugs, changes },
  }
}

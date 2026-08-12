import { wrap } from "@reatom/core";
import * as errore from "errore";

import type { DesignTreeReader } from "core/ports";
import type {
  EventPayloadByKindV1,
  FailureDtoV1,
  PageDescriptorChangeV1,
  PageDescriptorV1,
  Sha256Hex,
} from "core/protocol";
import { DESIGN_SYSTEM_MANIFEST_RELPATH, decodeDesignSystemManifest } from "entities/design-system";
import type { DesignSystemManifestV1 } from "entities/design-system";
import { DESIGN_DIRNAME, PAGES_MANIFEST_RELPATH } from "entities/design-tree";
import type { PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";
import { log } from "infrastructure/debug-log";

/**
 * `core/protocol`'s own index only re-exports `EventPayloadByKindV1` (the per-kind payload
 * map) and its runtime schema map — the individual payload type names declared in
 * `event-payload.ts` (`PageDescriptorsChangedPayloadV1`, `...ReasonV1`) are not re-exported
 * from the top-level barrel. Indexing the map by kind is the same type without a second,
 * un-re-exported import path.
 */
type PageDescriptorsChangedPayloadV1 = EventPayloadByKindV1["page.descriptorsChanged"];
type PageDescriptorsChangedReasonV1 = PageDescriptorsChangedPayloadV1["reason"];

/**
 * The `page.descriptorsChanged` payload (kernel-command-contract §9, KCC:797): "The
 * descriptor list is complete and ordered; each non-removed descriptor and every change
 * carries its exact before/after source-hash binding."
 *
 * This module does not COMPUTE a `PageDescriptorV1` (that requires running Gate over a
 * page module's `meta` export — a capability this module does not have, `core/ports/
 * gate-runner.ts`'s domain). It assembles the payload from two already-known descriptor
 * lists — the state before a mutation and the state after — diffing them into the exact
 * `changes` array §9 requires. `after` is threaded straight into the payload's
 * `descriptors` field UNCHANGED so "complete and ordered" is a fact about the caller's
 * input, not something this module could silently reorder or drop from.
 */

/**
 * One page's entry file, read through `design/pages.json` (task 14; brief step 5: "read the
 * manifest, find the slug's entry, `readTreeFile(entry)` ... extract that two-step into one
 * shared helper rather than repeating it three times").
 *
 * `relPath` is the TREE-relative path the manifest bound to the slug — carried alongside the
 * bytes because every caller needs it for something (a Gate `sourcePath`, a `changedFiles`
 * op, a display name) and re-deriving it would mean a second manifest read.
 */
export interface PageEntrySourceV1 {
  readonly pageSlug: PageSlug;
  readonly relPath: string;
  readonly bytes: Uint8Array;
  readonly sourceHash: Sha256Hex;
}

/** The `design/pages.json` entry `pageSlug` is bound to, or a typed refusal naming which half failed. */
function entryNotFound(pageSlug: PageSlug): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `design/pages.json lists no entry for page "${pageSlug}"`,
    details: { pageSlug },
  };
}

/**
 * The manifest's page order — `design/pages.json`'s array order IS page order (design §4), so
 * this is the project's one page-identity and ordering authority. The replacement for the
 * retired `PageReader.listSlugs()`, which promised the same list from a port that had no way
 * to know it.
 *
 * A TREE WITH NO MANIFEST IS AN EMPTY PAGE ORDER, NOT A FAILURE — and the difference is
 * decided STRUCTURALLY, never by matching on a failure's prose. A freshly created project has
 * no `design/pages.json` until its first turn writes one, and the retired `listSlugs()` had a
 * documented allowance for exactly that ("`[]` for a project with no `design/pages.json` yet
 * ... never an error", `store/model/design-tree-store.ts`). `DesignTreeReader.readManifest()`
 * deliberately makes no such allowance — what a tree-less project looks like on disk is
 * Task 16's own question (red-debt.md) — so the allowance lives HERE instead, at the one seam
 * that lost it when task 14 retired `listSlugs`' last caller.
 *
 * The test is whether the tree ITSELF names `pages.json`: absent from the inventory means the
 * project genuinely has no manifest yet (honest empty order); present means the read/decode
 * failure is real and is propagated. `treePaths` lets a caller that already walked the tree
 * (`core/kernel`'s turn staging) answer that without a second `listTree()`; the extra walk is
 * paid only on the failure path otherwise. If the inventory ITSELF cannot be read, the
 * original manifest failure is returned unchanged — never masked by a second one.
 *
 * THE ALLOWANCE FAILS CLOSED, AND EVERY SWALLOW LOGS (task-14 review round 1, Important 4).
 * This function is the sole authority on page order for nine calling modules, and turning a
 * real failure into "the project is empty" here is invisible to every one of them. Two
 * conflations were measured and are refused rather than documented:
 *
 *   - `pages.json` existing as a DIRECTORY. `listTree()` then names `pages.json/inner.txt` and
 *     an exact-equality test says "absent", so a genuinely broken tree read as empty. A path
 *     UNDER `pages.json/` now counts as present, so the manifest failure propagates.
 *   - A caller passing the PROJECT-relative vocabulary (`design/pages.json`) instead of the
 *     tree-relative one. Every entry would then miss the exact test and a broken manifest
 *     would read as empty. `readonly string[]` cannot distinguish the two vocabularies in the
 *     type, so it is detected at runtime and refused — a caller bug must not present as an
 *     empty project. NARROWED (task-14 review round 2, M2): the evidence is `design/pages.json`
 *     present WHILE tree-relative `pages.json` is absent — the one shape only a vocabulary
 *     mistake produces. The round-1 test was "any path starts with `design/`", which FALSE-FIRED
 *     on a legal tree: `entryPathSchema` permits `design/tokens.ts` as a tree-relative path, so
 *     a `design/` SUBDIRECTORY inside the tree is ordinary, and the check turned an honest empty
 *     page order into an `abortEarlyAdmission` on `turn.start`.
 *
 * Every branch that discards a `FailureDtoV1` logs it first (errore rule 21: an error that is
 * not propagated must still leave a trace). Before this round all three discarded silently.
 */
export async function readPageOrder(
  designReader: DesignTreeReader,
  treePaths?: readonly string[],
): Promise<FailureDtoV1 | readonly PageEntryV1[]> {
  const manifest = await wrap(designReader.readManifest());
  if (!("code" in manifest)) return manifest.pages;

  const paths = treePaths ?? (await readTreePaths(designReader, manifest));
  if ("code" in paths) return paths;

  // Present as the file itself, or as a DIRECTORY of that name — either way the tree has
  // something at `pages.json`, so the read/decode failure above is real.
  const manifestPresent = paths.some(
    (relPath) =>
      relPath === PAGES_MANIFEST_RELPATH || relPath.startsWith(`${PAGES_MANIFEST_RELPATH}/`),
  );
  if (manifestPresent) return manifest;

  // The caller handed us project-relative paths — the ONE shape only a vocabulary mistake
  // produces: the project-relative manifest path is there while the tree-relative one is not.
  // Refusing beats guessing: silently stripping a `design/` prefix would make this function
  // accept two vocabularies, and the plan fixes exactly one for this argument.
  if (paths.includes(`${DESIGN_DIRNAME}/${PAGES_MANIFEST_RELPATH}`)) {
    log.warn(
      `core/project/descriptors: readPageOrder was given PROJECT-relative treePaths (they name "${DESIGN_DIRNAME}/${PAGES_MANIFEST_RELPATH}" but no "${PAGES_MANIFEST_RELPATH}"); it requires TREE-relative paths, so the manifest failure is propagated rather than read as an empty project`,
    );
    return manifest;
  }

  // The one honest empty: the tree names no manifest, so there is nothing to have failed.
  log.warn(
    `core/project/descriptors: design/pages.json is absent from the tree — reading an empty page order (a project has no manifest until its first turn writes one). The underlying read reported: ${manifest.safeMessage}`,
  );
  return [];
}

/** {@link readPageOrder}'s own inventory read, used only when the caller supplied none. A failure here is logged and the ORIGINAL manifest failure is returned — never masked by this second one. */
async function readTreePaths(
  designReader: DesignTreeReader,
  manifestFailure: FailureDtoV1,
): Promise<FailureDtoV1 | readonly string[]> {
  const listed = await wrap(designReader.listTree());
  if ("code" in listed) {
    log.warn(
      `core/project/descriptors: could not list the design tree to tell an absent design/pages.json from an unreadable one (${listed.safeMessage}); propagating the original manifest failure`,
    );
    return manifestFailure;
  }
  return listed.map((file) => file.relPath);
}

/**
 * `system/design-system.json`, decoded — or `null` (plan P4 decision D7). Placed beside
 * {@link readPageOrder} because both answer "what does this tree currently declare" from the
 * same `treePaths` a caller already walked, but they answer DIFFERENTLY on a broken file:
 *
 *   - ABSENT from `treePaths` -> `null`. The ordinary case: every project has no design system
 *     until the mechanical migration writes one (design-systems §9).
 *   - PRESENT but does not decode -> `null`, logged via `log.warn` — NEVER thrown, NEVER a
 *     `FailureDtoV1`.
 *
 * CONTRAST WITH `readPageOrder`, DELIBERATELY: a present-but-undecodable `design/pages.json`
 * PROPAGATES as a refusal (see that function's own doc) because a broken page order corrupts
 * every downstream page-identity decision this handler makes for the rest of the turn. A broken
 * design-system manifest has no such blast radius — `gate` already reports an invalid manifest
 * as its own fatal, on the same candidate, before any commit reaches disk — so refusing the
 * turn here too would make a project whose manifest an agent just broke unopenable AND
 * unrepairable, since the repair is itself a turn that would need this very read to succeed
 * first. Every branch that discards the decode failure logs it (errore rule 21).
 *
 * MIRRORS, RATHER THAN DUPLICATES BY ACCIDENT: `core/project/model/tree-index.ts`'s own
 * `decodeDesignSystemFrom` makes the identical present-and-undecodable-is-null-plus-warn
 * allowance, for the identical reason (its own doc cites this same D7). It is not reused
 * directly because it decodes from an ALREADY-READ `files` map — `readCanonicalTreeIndex` reads
 * every tree file's text up front, for the whole-tree Gate pass. This function is called from
 * `turn.start`, which at this point in the handler holds only `treePaths` (a `listTree()`
 * result) and has no other reason to read the rest of the tree's text just to answer this one
 * question — so it performs its own single `readTreeFile`, the way `readPageEntrySource` below
 * reads one page's own entry rather than taking a pre-read map. Keep the two decode-or-null
 * branches read the same way if either changes; a different message shape here would make the
 * exact same manifest failure trace differently depending on which caller hit it.
 */
export async function readDesignSystemManifest(
  designReader: DesignTreeReader,
  treePaths: readonly string[],
): Promise<DesignSystemManifestV1 | null> {
  if (!treePaths.includes(DESIGN_SYSTEM_MANIFEST_RELPATH)) return null;

  const file = await wrap(designReader.readTreeFile(DESIGN_SYSTEM_MANIFEST_RELPATH));
  if ("code" in file) {
    log.warn(
      `core/project/descriptors: the tree names "${DESIGN_SYSTEM_MANIFEST_RELPATH}" but it could not be read (${file.safeMessage}); treating the project as having no design system (P4 D7)`,
    );
    return null;
  }

  const decoded = decodeDesignSystemManifest(new TextDecoder().decode(file.bytes));
  if (decoded instanceof Error) {
    log.warn(
      `core/project/descriptors: "${DESIGN_SYSTEM_MANIFEST_RELPATH}" did not decode (${decoded.message}) — the Gate reports this as a fatal on the candidate; treating the project as having no design system rather than refusing the turn, so a manifest an agent broke stays repairable on its next turn (P4 D7)`,
    );
    return null;
  }
  return decoded;
}

/**
 * THE TWO-STEP, IN ONE PLACE: read `design/pages.json`, find `pageSlug`'s own `entry`, then
 * read THAT tree file. Nothing here computes a path from a slug — that mapping is exactly what
 * the multi-file design tree retires (design §3, §7), and the reason `PageReader.readSource`
 * could not survive it.
 *
 * Takes an already-read `pages` list when the caller has one (every loop over all pages does),
 * so a per-page read never re-reads the manifest once per page.
 */
export async function readPageEntrySource(
  designReader: DesignTreeReader,
  pageSlug: PageSlug,
  pages?: readonly PageEntryV1[],
): Promise<FailureDtoV1 | PageEntrySourceV1> {
  const entries = pages ?? (await wrap(readPageOrder(designReader)));
  if ("code" in entries) return entries;

  const entry = entries.find((candidate) => candidate.slug === pageSlug);
  if (entry === undefined) return entryNotFound(pageSlug);

  const file = await wrap(designReader.readTreeFile(entry.entry));
  if ("code" in file) return file;
  return { pageSlug, relPath: entry.entry, bytes: file.bytes, sourceHash: file.sha256 };
}

/** A caller supplied a malformed descriptor list — most concretely, a duplicate `pageSlug`. */
export class PageDescriptorsAssemblyError extends errore.createTaggedError({
  name: "PageDescriptorsAssemblyError",
  message: "cannot assemble page.descriptorsChanged: $reason",
}) {}

function findDuplicateSlug(descriptors: readonly PageDescriptorV1[]): string | null {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.pageSlug)) return descriptor.pageSlug;
    seen.add(descriptor.pageSlug);
  }
  return null;
}

/** Deep-equality over one descriptor's own content (excluding its position in the list). */
function descriptorsEqual(a: PageDescriptorV1, b: PageDescriptorV1): boolean {
  if (a.status !== b.status) return false;
  if (a.sourceHash !== b.sourceHash) return false;
  if (a.status === "ready" && b.status === "ready") {
    return (
      a.title === b.title &&
      a.minSize.w === b.minSize.w &&
      a.minSize.h === b.minSize.h &&
      a.theme === b.theme &&
      a.kitApiVersion === b.kitApiVersion
    );
  }
  if (a.status === "invalid" && b.status === "invalid") {
    return a.error.code === b.error.code && a.error.safeMessage === b.error.safeMessage;
  }
  return false;
}

/**
 * Diffs two ordered descriptor lists into §9's `changes` array. Every entry carries its
 * exact before/after source-hash binding, including `added`/`removed` entries whose
 * missing side is explicitly `null` rather than omitted (matching `PageDescriptorChangeV1`'s
 * own doc). A page whose content is byte-identical but moved position is "reordered", never
 * "updated" — those are disjoint outcomes for the same page in one diff.
 */
export function computePageDescriptorChanges(
  before: readonly PageDescriptorV1[],
  after: readonly PageDescriptorV1[],
): readonly PageDescriptorChangeV1[] {
  const beforeBySlug = new Map(
    before.map((descriptor, index) => [descriptor.pageSlug, { descriptor, index }]),
  );
  const afterBySlug = new Map(
    after.map((descriptor, index) => [descriptor.pageSlug, { descriptor, index }]),
  );

  const changes: PageDescriptorChangeV1[] = [];

  for (const [pageSlug, { descriptor }] of beforeBySlug) {
    if (afterBySlug.has(pageSlug)) continue;
    changes.push({
      pageSlug,
      kind: "removed",
      beforeSourceHash: descriptor.sourceHash,
      afterSourceHash: null,
    });
  }

  for (const [pageSlug, { descriptor: afterDescriptor, index: afterIndex }] of afterBySlug) {
    const beforeEntry = beforeBySlug.get(pageSlug);
    if (beforeEntry === undefined) {
      changes.push({
        pageSlug,
        kind: "added",
        beforeSourceHash: null,
        afterSourceHash: afterDescriptor.sourceHash,
      });
      continue;
    }

    const { descriptor: beforeDescriptor, index: beforeIndex } = beforeEntry;
    if (!descriptorsEqual(beforeDescriptor, afterDescriptor)) {
      changes.push({
        pageSlug,
        kind: "updated",
        beforeSourceHash: beforeDescriptor.sourceHash,
        afterSourceHash: afterDescriptor.sourceHash,
      });
      continue;
    }

    if (beforeIndex !== afterIndex) {
      changes.push({
        pageSlug,
        kind: "reordered",
        beforeSourceHash: beforeDescriptor.sourceHash,
        afterSourceHash: afterDescriptor.sourceHash,
      });
    }
  }

  return changes;
}

/**
 * Assembles the complete `page.descriptorsChanged` payload. Validates both descriptor
 * lists have no duplicate `pageSlug` before diffing — a duplicate is a producer bug
 * (two descriptors for one page cannot both be "the" descriptor for that slug) and is
 * surfaced as a typed error rather than silently diffed against one arbitrary copy.
 *
 * `treeRevision` is threaded straight through, exactly like `after`: it is the caller's own
 * fact about the tree it read this list from (`readCanonicalTreeIndex`'s `treeRevision`),
 * and nothing here could recompute it — the descriptors carry entry hashes only, never the
 * shared modules those entries import. See `PageDescriptorsChangedPayloadV1`'s own header
 * for why the payload needs a field KCC:797 does not list.
 */
export function buildPageDescriptorsChangedPayload(
  reason: PageDescriptorsChangedReasonV1,
  before: readonly PageDescriptorV1[],
  after: readonly PageDescriptorV1[],
  activePageSlug: PageSlug | null,
  treeRevision: string,
): PageDescriptorsAssemblyError | PageDescriptorsChangedPayloadV1 {
  const duplicateBefore = findDuplicateSlug(before);
  if (duplicateBefore !== null) {
    return new PageDescriptorsAssemblyError({
      reason: `duplicate pageSlug "${duplicateBefore}" in the before list`,
    });
  }
  const duplicateAfter = findDuplicateSlug(after);
  if (duplicateAfter !== null) {
    return new PageDescriptorsAssemblyError({
      reason: `duplicate pageSlug "${duplicateAfter}" in the after list`,
    });
  }

  return {
    reason,
    descriptors: after,
    changes: computePageDescriptorChanges(before, after),
    activePageSlug,
    treeRevision,
  };
}

import * as errore from "errore";

import type { EventPayloadByKindV1, PageDescriptorChangeV1, PageDescriptorV1 } from "core/protocol";
import type { PageSlug } from "entities/page";

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
 */
export function buildPageDescriptorsChangedPayload(
  reason: PageDescriptorsChangedReasonV1,
  before: readonly PageDescriptorV1[],
  after: readonly PageDescriptorV1[],
  activePageSlug: PageSlug | null,
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
  };
}

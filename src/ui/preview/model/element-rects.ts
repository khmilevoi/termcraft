import type { LayoutNodeV1 } from "core/protocol";

import type { Rect } from "./overlay";

/**
 * Every element the host's current render actually contains, mapped to its own rectangle.
 *
 * An id ABSENT from this map is the design spec's own "not visible in the current render
 * (hidden or removed)" (§3.2) — the anchor-resolution signal the mirror does not carry.
 */
export type ElementRectIndex = ReadonlyMap<string, Rect>;

/**
 * Flattens one `layoutTree()` reply (design §4.2) into that map. This is the batch form of
 * `rectOf`: one `layout` query answers for every element at once, so N pins on a frame cost
 * one round trip rather than N.
 *
 * Pre-order, FIRST occurrence wins — the same element a single `rectOf(id)` would return,
 * whose `findDescendantById` likewise stops at the first match
 * (`host/render/model/geometry.ts`). A design that renders one id twice is already outside
 * the runtime's stable-id contract; this keeps the two query paths from disagreeing about it.
 */
export function indexElementRects(tree: LayoutNodeV1): ElementRectIndex {
  const index = new Map<string, Rect>();
  const visit = (node: LayoutNodeV1): void => {
    if (!index.has(node.id)) index.set(node.id, node.box);
    for (const child of node.children) visit(child);
  };
  visit(tree);
  return index;
}

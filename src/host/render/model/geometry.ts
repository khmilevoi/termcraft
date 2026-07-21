import type { CliRenderer, Renderable } from "@opentui/core";

import type { DescribedElement, LayoutNode, Rect } from "../types";

/**
 * Real (not simulated) geometry primitives over OpenTUI's own mounted renderable tree —
 * the design doc's `checkHit(x,y) → id`, `rectOf(id) → Rect`, `describe(id) → component
 * kind + label`, and `layoutTree() → the resolved node tree` (§4.2). All four walk
 * `Renderable`'s own public `screenX`/`screenY`/`width`/`height` getters and
 * `findDescendantById`/`getChildren` — real geometry, not fabricated.
 *
 * `hitTestRenderer` is a deterministic point-in-rectangle tree walk, NOT
 * `CliRenderer.hitTest`/its native hit-grid: a throwaway repro against this exact
 * headless setup showed the native hit-grid's populated-vs-empty state race against the
 * JS-side render commit (identical await sequence returned a hit on some runs and none on
 * others). The design's own §5.2 invariant — "`checkHit`/`rectOf` deterministically
 * resolve" — rules out a racy backing primitive, so this walks the same reliably-
 * synchronous layout geometry `rectOf`/`layoutTree` use, never the native grid.
 *
 * KNOWN DIVERGENCE (documented per CLAUDE.md, "document the divergence in a code
 * comment"): the design's `@termcraft/runtime` component catalog (§5.2 — themed
 * components with a mandatory stable `id` prop) does not exist yet, so no design page
 * assigns meaningful ids today; `@opentui/react`'s reconciler auto-assigns AN id per
 * element regardless (`getNextId`), so these primitives already resolve REAL ids the
 * moment `runtime` starts forwarding its own mandatory `id` prop — nothing here needs to
 * change when that lands. `describe`'s `kind` is the real OpenTUI renderable constructor
 * name (e.g. `"BoxRenderable"`), not the design catalog's semantic vocabulary
 * (Button/Panel/Text/…) — that mapping, and any human-facing `label`, requires the
 * runtime catalog's own per-component knowledge and is deferred until it lands.
 * `layoutTree`'s nodes omit `text` for the same reason.
 */
function containsPoint(renderable: Renderable, x: number, y: number): boolean {
  if (!renderable.visible) return false;
  const left = renderable.screenX;
  const top = renderable.screenY;
  return x >= left && x < left + renderable.width && y >= top && y < top + renderable.height;
}

/** Deepest, topmost (last-child-wins) match containing the point — deterministic, no native call. */
function hitTestNode(renderable: Renderable, x: number, y: number): Renderable | null {
  const children = renderable.getChildren();
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i];
    if (child === undefined) continue;
    const hit = hitTestNode(child, x, y);
    if (hit !== null) return hit;
  }
  return containsPoint(renderable, x, y) ? renderable : null;
}

export function hitTestRenderer(renderer: CliRenderer, x: number, y: number): string | null {
  return hitTestNode(renderer.root, x, y)?.id ?? null;
}

function rectOfRenderable(renderable: Renderable): Rect {
  return {
    x: renderable.screenX,
    y: renderable.screenY,
    width: renderable.width,
    height: renderable.height,
  };
}

export function rectOfElement(renderer: CliRenderer, id: string): Rect | null {
  const found = renderer.root.findDescendantById(id);
  if (found === undefined) return null;
  return rectOfRenderable(found);
}

export function describeElement(renderer: CliRenderer, id: string): DescribedElement | null {
  const found = renderer.root.findDescendantById(id);
  if (found === undefined) return null;
  return { id: found.id, kind: found.constructor.name };
}

function layoutNodeOf(renderable: Renderable): LayoutNode {
  return {
    id: renderable.id,
    kind: renderable.constructor.name,
    box: rectOfRenderable(renderable),
    children: renderable.getChildren().map(layoutNodeOf),
  };
}

export function layoutTreeOf(renderer: CliRenderer): LayoutNode {
  return layoutNodeOf(renderer.root);
}

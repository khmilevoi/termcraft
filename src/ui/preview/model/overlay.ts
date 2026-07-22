/**
 * Preview overlay geometry (design §3.2 / design/07-selection-hover.dc.html /
 * design/08-pin-comments.dc.html). Pure math the preview shell uses to place pin badges and
 * selection corner glyphs over the composited frame. Absolute cell coordinates, relative to
 * the preview region's own origin.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The cell a pin badge sits on: `rect.origin + (fx*width, fy*height)`, clamped into the rect
 * (design §3.2: "rendered at `rect.origin + (fx·width, fy·height)`, clamped"). `fx`/`fy` are
 * the pin's normalized anchor in `[0,1]`.
 */
export function pinAnchor(fx: number, fy: number, rect: Rect): Point {
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value));
  return {
    x: rect.x + clamp(Math.round(fx * (rect.width - 1)), rect.width - 1),
    y: rect.y + clamp(Math.round(fy * (rect.height - 1)), rect.height - 1),
  };
}

/** The four selection-corner glyph positions, one cell OUTSIDE the selected rect (design `selCorners`). */
export interface SelectionCorners {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomLeft: Point;
  readonly bottomRight: Point;
}

/** The `⌜ ⌝ ⌞ ⌟` corner positions for a selected element's rect (design `selCorners`, `:381-382`). */
export function selectionCorners(rect: Rect): SelectionCorners {
  return {
    topLeft: { x: rect.x - 1, y: rect.y - 1 },
    topRight: { x: rect.x + rect.width, y: rect.y - 1 },
    bottomLeft: { x: rect.x - 1, y: rect.y + rect.height },
    bottomRight: { x: rect.x + rect.width, y: rect.y + rect.height },
  };
}

/** The four selection-corner glyphs in visual order (top-left, top-right, bottom-left, bottom-right). */
export const SELECTION_GLYPHS = ["⌜", "⌝", "⌞", "⌟"] as const;

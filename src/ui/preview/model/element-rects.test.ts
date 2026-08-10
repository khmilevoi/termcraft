import { describe, expect, test } from "bun:test";

import type { LayoutNodeV1 } from "core/protocol";

import { indexElementRects } from "./element-rects";

const node = (
  id: string,
  box: { x: number; y: number; width: number; height: number },
  children: readonly LayoutNodeV1[] = [],
): LayoutNodeV1 => ({ id, kind: "BoxRenderable", box, children });

describe("indexElementRects", () => {
  test("indexes every node in the tree, root and descendants alike", () => {
    const tree = node("root", { x: 0, y: 0, width: 40, height: 12 }, [
      node("header", { x: 0, y: 0, width: 40, height: 1 }),
      node("body", { x: 0, y: 2, width: 40, height: 10 }, [
        node("digital-time", { x: 6, y: 3, width: 17, height: 1 }),
      ]),
    ]);

    const index = indexElementRects(tree);

    expect(index.size).toBe(4);
    expect(index.get("digital-time")).toEqual({ x: 6, y: 3, width: 17, height: 1 });
    expect(index.get("root")).toEqual({ x: 0, y: 0, width: 40, height: 12 });
  });

  test("an id the render does not contain is absent, never a fabricated rect", () => {
    expect(indexElementRects(node("root", { x: 0, y: 0, width: 4, height: 4 })).has("gone")).toBe(
      false,
    );
  });

  test("keeps the first pre-order match for a duplicated id, as rectOf's own lookup does", () => {
    const tree = node("root", { x: 0, y: 0, width: 40, height: 12 }, [
      node("twin", { x: 1, y: 1, width: 2, height: 2 }),
      node("twin", { x: 9, y: 9, width: 3, height: 3 }),
    ]);

    expect(indexElementRects(tree).get("twin")).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });
});

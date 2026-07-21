import { afterEach, describe, expect, test } from "bun:test";

import type { RenderHandle } from "../types";
import { createHeadlessRenderer } from "./renderer";

// Every live renderer MUST be destroyed so `bun test` can exit (Spike D).
let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

describe("RenderHandle geometry queries (design doc §4.2: checkHit/rectOf/describe/layoutTree)", () => {
  test("hitTest resolves the topmost element's id at an in-bounds point, and null outside any element", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box id="panel">
        <text id="label">hi</text>
      </box>,
    );
    await handle.render();

    // Assert the EXACT id, not merely that something non-null came back. `hitTest` is
    // declared `(x, y) => string | null`, so an assertion like
    // `hit === null || typeof hit === "string"` is unfalsifiable by construction — it
    // holds for a fabricated constant just as well as for a real lookup, which is the one
    // failure mode a hit test has. §8.1's token chain makes a resolving hit the SOLE
    // source of a GeometryTokenV1, so an invented id here would mint a pin anchored to
    // nothing.
    expect(handle.hitTest(0, 0)).toBe("label");
    expect(handle.hitTest(1, 0)).toBe("label");

    // Inside the 20x4 frame but below the text: the root, not the text.
    expect(handle.hitTest(0, 1)).toBe("__root__");
    expect(handle.hitTest(19, 3)).toBe("__root__");

    // Genuinely outside the frame — nothing is mounted there. (19,3) is NOT outside: it
    // is the last cell inside a 20x4 frame, which is why the previous version of this
    // test could only be written as a tautology.
    expect(handle.hitTest(100, 100)).toBeNull();
    expect(handle.hitTest(-1, -1)).toBeNull();
  });

  test("rectOf returns the element's absolute box, and null for an unknown id", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box id="panel">
        <text id="label">hi</text>
      </box>,
    );
    await handle.render();

    const rect = handle.rectOf("panel");
    expect(rect).not.toBeNull();
    expect(rect?.width).toBeGreaterThan(0);
    expect(rect?.height).toBeGreaterThan(0);

    expect(handle.rectOf("does-not-exist")).toBeNull();
  });

  test("describe returns the real underlying renderable kind, and null for an unknown id", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box id="panel">
        <text id="label">hi</text>
      </box>,
    );
    await handle.render();

    const described = handle.describe("panel");
    expect(described).not.toBeNull();
    expect(described?.id).toBe("panel");
    expect(typeof described?.kind).toBe("string");
    expect(described?.kind.length).toBeGreaterThan(0);

    expect(handle.describe("does-not-exist")).toBeNull();
  });

  test("layoutTree walks the real mounted tree and includes both stable ids", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box id="panel">
        <text id="label">hi</text>
      </box>,
    );
    await handle.render();

    const tree = handle.layoutTree();
    const ids: string[] = [];
    const collect = (node: typeof tree): void => {
      ids.push(node.id);
      for (const child of node.children) collect(child);
    };
    collect(tree);
    expect(ids).toContain("panel");
    expect(ids).toContain("label");
  });
});

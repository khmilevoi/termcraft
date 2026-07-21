import { afterEach, describe, expect, test } from "bun:test";

import type { RenderHandle } from "../types";
import { createHeadlessRenderer, renderNodeOnce } from "./renderer";

// Every live renderer MUST be destroyed so `bun test` can exit (Spike D).
let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

// Concatenate a row's run text back into a line string for content assertions.
const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

describe("headless renderer", () => {
  test("renders a static box+text tree and captures the frame", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box>
        <text>hello</text>
      </box>,
    );
    await handle.render();
    const frame = handle.capture();

    expect(frame.width).toBe(20);
    expect(frame.height).toBe(4);
    expect(frame.rows).toHaveLength(4);
    // "hello" appears somewhere in the first row's runs.
    expect(lineText(frame, 0)).toContain("hello");
  });

  test("renderNodeOnce creates, renders, captures, and tears down", async () => {
    const frame = await renderNodeOnce(
      <box>
        <text>once</text>
      </box>,
      { w: 12, h: 2 },
    );
    expect(frame.height).toBe(2);
    expect(lineText(frame, 0)).toContain("once");
  });

  test("resize changes the captured dimensions without re-mounting", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 3 });
    open = handle;
    handle.mount(
      <box>
        <text>resize-me</text>
      </box>,
    );
    await handle.render();
    expect(handle.capture().width).toBe(10);

    handle.resize({ w: 24, h: 5 });
    await handle.render();
    const frame = handle.capture();
    expect(frame.width).toBe(24);
    expect(frame.height).toBe(5);
    expect((frame.rows[0] ?? []).map((r) => r.text).join("")).toContain("resize-me");
  });
});

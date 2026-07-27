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

/**
 * THE DEFECT THIS PINS (2026-07-27): a page that THROWS while rendering used to be
 * indistinguishable from one that rendered fine. `@opentui/react`'s `createRoot` wraps
 * every mounted tree in its OWN `ErrorBoundary` (`chunk-hjtp6jv9.js:585`) and hands the
 * reconciler `console.error` for all three error channels, so nothing propagates out of
 * `root.render(...)`: `render()`/`capture()` both succeed and seal a frame carrying the
 * red stack trace. The gate's smoke stage (`gate/model/gate.ts:103`) reads only "did the
 * one-shot seal a frame", so it passed such a page, the turn committed, and the user was
 * told the page had been updated while the preview showed a stack trace.
 *
 * `renderError()` is the honest answer to "did the mounted tree actually render". It is
 * captured by a boundary mounted INSIDE OpenTUI's own (React routes a throw to the
 * NEAREST enclosing boundary), so ours wins and OpenTUI's never trips.
 */
describe("headless renderer — render-error capture", () => {
  function Boom(): never {
    throw new TypeError("ctx.spy is not a function");
  }

  test("a component that throws is reported through renderError() instead of passing silently", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(<Boom />);
    await handle.render();

    const failure = handle.renderError();
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("ctx.spy is not a function");
  });

  test("a tree that renders cleanly reports no render error", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(
      <box>
        <text>fine</text>
      </box>,
    );
    await handle.render();

    expect(handle.renderError()).toBeNull();
  });

  test("re-mounting a healthy tree clears a previous mount's render error", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 });
    open = handle;
    handle.mount(<Boom />);
    await handle.render();
    expect(handle.renderError()).toBeInstanceOf(Error);

    handle.mount(
      <box>
        <text>recovered</text>
      </box>,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
  });
});

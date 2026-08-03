import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import type { Size } from "../../types";
import type { CapturedFrame, RenderHandle } from "../types";
import { createRenderErrorSink, withRenderErrorCapture } from "./error-capture";
import type { RenderErrorSink } from "./error-capture";
import { describeElement, hitTestRenderer, layoutTreeOf, rectOfElement } from "./geometry";
import { styledRowsFromSpanLines } from "./span-rows";
import { createHeadlessStreams } from "./streams";

/**
 * Create a headless OpenTUI renderer on the public API with fake TTY streams and
 * memory-buffered output. The returned handle mounts a React tree, paints, and
 * captures styled frames. The caller owns teardown (and, in a one-shot host
 * process, the `process.exit` that Spike D requires — never call it here).
 */
export async function createHeadlessRenderer(size: Size): Promise<RenderHandle> {
  const { stdin, stdout } = createHeadlessStreams(size);
  const renderer: CliRenderer = await createCliRenderer({
    stdin: stdin as never,
    stdout: stdout as never,
    width: size.w,
    height: size.h,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    externalOutputMode: "passthrough",
    useMouse: false,
    exitOnCtrlC: false,
  });
  const root = createRoot(renderer);
  // Re-created per `mount()`: a fresh tree gets a clean verdict, so re-mounting a healthy
  // page never keeps reporting the previous mount's failure. See `./error-capture.ts` for
  // why a boundary is the only way to observe a render throw through `@opentui/react`.
  let errorSink: RenderErrorSink = createRenderErrorSink();

  return {
    mount(node) {
      errorSink = createRenderErrorSink();
      root.render(withRenderErrorCapture(node as never, errorSink) as never);
    },
    renderError() {
      return errorSink.taken;
    },
    async render() {
      renderer.intermediateRender();
      await renderer.idle();
    },
    capture(): CapturedFrame {
      const buffer = renderer.currentRenderBuffer;
      return {
        width: buffer.width,
        height: buffer.height,
        rows: styledRowsFromSpanLines(buffer.getSpanLines()),
      };
    },
    resize(size) {
      renderer.resize(size.w, size.h);
    },
    destroy() {
      root.unmount();
      renderer.destroy();
    },
    hitTest(x, y) {
      return hitTestRenderer(renderer, x, y);
    },
    rectOf(id) {
      return rectOfElement(renderer, id);
    },
    describe(id) {
      return describeElement(renderer, id);
    },
    layoutTree() {
      return layoutTreeOf(renderer);
    },
  };
}

/** One-shot render: create, mount, paint, capture, tear down. */
export async function renderNodeOnce(node: unknown, size: Size): Promise<CapturedFrame> {
  const handle = await createHeadlessRenderer(size);
  try {
    handle.mount(node);
    await handle.render();
    return handle.capture();
  } finally {
    handle.destroy();
  }
}

import { describe, expect, test } from "bun:test";

import type { PreviewFrameV1 } from "core/ports";
import { TEST_SHA, createFakeKernel, createFakePreviewSession } from "ui/testing";

import { UiPreviewStreamError, createUiDeps } from "./deps";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function frame(sessionId: string): PreviewFrameV1 {
  return {
    sessionId,
    sourceHash: TEST_SHA,
    frameSeq: "1",
    width: 1,
    height: 1,
    rows: [[{ text: "x", fg: "default", bg: "default", attrs: 0 }]],
  };
}

describe("createUiDeps runtime", () => {
  test("removes its Kernel subscription when the runtime atom disconnects", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(kernel.subscriberCount()).toBe(1);

    unsubscribe();
    await tick();
    expect(kernel.subscriberCount()).toBe(0);
  });

  test("keeps a Kernel subscription failure in runtimeError", async () => {
    const subscriptionFailure = new Error("snapshot unavailable");
    const kernel = createFakeKernel();
    const port = { ...kernel, subscribe: () => subscriptionFailure };
    const deps = createUiDeps(port, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    expect(deps.runtimeError()).toBe(subscriptionFailure);
    unsubscribe();
  });

  test("turns a frame-stream rejection into UiPreviewStreamError", async () => {
    const sourceFailure = new Error("stream lost");
    const preview = createFakePreviewSession();
    const rejectedFrames: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(sourceFailure) };
      },
    };
    const handle = {
      ...preview.handle,
      session: { ...preview.handle.session, frames: rejectedFrames },
      frames: rejectedFrames,
    };
    const kernel = createFakeKernel();
    kernel.setPreview(handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    await tick();
    const runtimeError = deps.runtimeError();
    unsubscribe();

    expect(runtimeError).toBeInstanceOf(UiPreviewStreamError);
    expect(runtimeError?.cause).toBe(sourceFailure);
  });

  test("keeps the displayed frame bundle intact", async () => {
    const preview = createFakePreviewSession();
    const kernel = createFakeKernel();
    kernel.setPreview(preview.handle);
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const displayed = frame(preview.handle.previewSessionId);

    const unsubscribe = deps.runtime.subscribe(() => undefined);
    preview.pushFrame(displayed);
    await tick();
    const latest = deps.previewFrame();
    unsubscribe();

    expect(latest?.frame).toBe(displayed);
    expect(latest?.frameToken).toBe(preview.frameTokenFor(displayed));
    expect(latest?.handle).toBe(preview.handle);
  });
});

import { describe, expect, test } from "bun:test";

import type { PreviewFrameV1 } from "core/ports";

import { TEST_SHA } from "./events";
import { createFakePreviewSession } from "./fake-preview";

describe("createFakePreviewSession", () => {
  test("emits each frame with its display token and originating handle", async () => {
    const preview = createFakePreviewSession();
    const frame: PreviewFrameV1 = {
      sessionId: preview.handle.previewSessionId,
      sourceHash: TEST_SHA,
      frameSeq: "1",
      width: 1,
      height: 1,
      rows: [[{ text: "x", fg: "default", bg: "default", attrs: 0 }]],
    };

    preview.pushFrame(frame);
    const next = await preview.handle.frames[Symbol.asyncIterator]().next();

    expect(next.value?.frameToken).toBe(preview.frameTokenFor(frame));
    expect(next.value?.frame).toBe(frame);
    expect(next.value?.handle).toBe(preview.handle);
  });

  test("returns and releases a blocked display-frame iterator", async () => {
    const preview = createFakePreviewSession();
    const iterator = preview.handle.frames[Symbol.asyncIterator]();
    const pending = iterator.next();

    expect(preview.activeFrameConsumers()).toBe(1);
    const returned = await iterator.return?.();

    expect(returned?.done).toBeTrue();
    expect((await pending).done).toBeTrue();
    expect(preview.activeFrameConsumers()).toBe(0);
  });
});

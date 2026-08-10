import { beforeEach, describe, expect, test } from "bun:test";

import type { PreviewFrameV1 } from "core/ports";
import type { FrameTokenV1, GeometryTokenV1, LayoutNodeV1, UUIDv7 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import {
  acknowledgeFrame,
  frameLocalPoint,
  handleGeometryResult,
  requestElementRects,
  requestGeometry,
} from "ui/preview";
import {
  TEST_NONCE,
  TEST_SHA,
  createFakeKernel,
  createFakePreviewSession,
  event,
  resetEventSeq,
  snapshot,
} from "ui/testing";

beforeEach(() => resetEventSeq());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const frame = (sessionId: string): PreviewFrameV1 => ({
  sessionId,
  sourceHash: TEST_SHA,
  frameSeq: "1",
  width: 20,
  height: 10,
  rows: [[{ text: "preview", fg: "default", bg: "default", attrs: 0 }]],
});

function harness() {
  const kernel = createFakeKernel();
  const preview = createFakePreviewSession();
  kernel.setPreview(preview.handle);
  const deps = createUiDeps(kernel, { w: 120, h: 36 });
  deps.mirror.apply(
    snapshot({
      projectId: uuidv7(),
      activePageSlug: "main",
      trust: "trusted",
    }),
  );
  const rendered = frame(preview.handle.previewSessionId);
  preview.pushFrame(rendered);
  const uiFrame = {
    frame: rendered,
    frameToken: preview.frameTokenFor(rendered),
    handle: preview.handle,
  };
  deps.previewFrame.set(uiFrame);
  return { deps, kernel, preview, uiFrame };
}

function geometryEvent(
  previewSessionId: UUIDv7,
  frameTokenId: FrameTokenV1,
  queryKind: "hit" | "pin-anchor",
  geometryToken: GeometryTokenV1 | null,
  /** The element the host resolved under the cursor; `null` is "nothing there". */
  hitElementId: string | null = "network",
) {
  return event("preview.geometryResult", {
    previewSessionId,
    frameTokenId,
    frameIdentity: {
      previewSessionId,
      nonce: TEST_NONCE,
      sourceHash: TEST_SHA,
      frameSeq: "1",
    },
    queryKind,
    // M21's closed `GeometryQueryResultV1` (`core/protocol`): a `checkHit` carries only the
    // resolved element id. Its rectangle comes from the frame's own element-rect map and its
    // page from the shell's active slug — see `handleGeometryResult`.
    result: { kind: "checkHit", hit: hitElementId === null ? null : { id: hitElementId } },
    geometryToken,
  });
}

describe("preview interaction token chain", () => {
  test("does not query geometry before the frame is display-acknowledged", () => {
    const { deps, kernel } = harness();
    requestGeometry(deps, "pin", 4, 5);

    expect(kernel.dispatched).toHaveLength(0);
  });

  test("acknowledges the exact frame token once", () => {
    const { deps, preview, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    acknowledgeFrame(deps, uiFrame);

    expect(preview.acknowledgements).toEqual([uiFrame.frameToken]);
  });

  test("a pin request dispatches the acknowledged token and frame-local point", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestGeometry(deps, "pin", 4, 5);

    const command = kernel.dispatched[0] as { kind: string; payload: unknown };
    expect(command.kind).toBe("preview.queryGeometry");
    expect(command.payload).toEqual({
      frameToken: uiFrame.frameToken,
      query: { kind: "pin-anchor", x: 4, y: 5 },
    });
  });

  test("pin to pin keeps one flight and never combines the first token with the second point", () => {
    const { deps, kernel, uiFrame } = harness();
    const firstGeometryToken = uuidv7();
    const secondGeometryToken = uuidv7();
    acknowledgeFrame(deps, uiFrame);

    requestGeometry(deps, "pin", 2, 3);
    requestGeometry(deps, "pin", 8, 9);

    expect(kernel.dispatched).toHaveLength(1);
    handleGeometryResult(
      deps,
      geometryEvent(
        uiFrame.handle.previewSessionId,
        uiFrame.frameToken,
        "pin-anchor",
        firstGeometryToken,
      ),
    );
    expect(deps.local.overlay()).toBeNull();
    expect(deps.interaction.pendingPin()).toBeNull();
    expect(kernel.dispatched).toHaveLength(2);
    expect((kernel.dispatched[1] as { payload: unknown }).payload).toEqual({
      frameToken: uiFrame.frameToken,
      query: { kind: "pin-anchor", x: 8, y: 9 },
    });

    handleGeometryResult(
      deps,
      geometryEvent(
        uiFrame.handle.previewSessionId,
        uiFrame.frameToken,
        "pin-anchor",
        secondGeometryToken,
      ),
    );
    expect(deps.interaction.pendingPin()).toEqual({
      geometryToken: secondGeometryToken,
      point: { x: 8, y: 9 },
    });
    expect(deps.local.overlay()).toBe("pin-input");
  });

  test("hover to select ignores the first hit's result and applies only the promoted latest hit's result", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestGeometry(deps, "hover", 1, 2);
    requestGeometry(deps, "select", 7, 8);

    expect(kernel.dispatched).toHaveLength(1);
    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );
    expect(deps.interaction.hover()).toBeNull();
    expect(deps.interaction.selectionRect()).toBeNull();
    expect(kernel.dispatched).toHaveLength(2);
    expect((kernel.dispatched[1] as { payload: unknown }).payload).toEqual({
      frameToken: uiFrame.frameToken,
      query: { kind: "hit", x: 7, y: 8 },
    });

    // The promoted (second) query's own result IS applied here — it selects the element the
    // host named. No THIRD geometry query fires: the queue is empty, which is what this test
    // is about. The hover rect stays null only because this frame's element rects have not
    // landed (see the element-rect tests); the selection itself resolves.
    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );
    expect(deps.interaction.hover()).toBeNull();
    expect(deps.interaction.selectionRect()).toBeNull();
    expect(
      kernel.dispatched.filter((raw) => (raw as { kind: string }).kind === "preview.queryGeometry"),
    ).toHaveLength(2);
  });

  test("three rapid intents retain only the newest queued geometry request", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestGeometry(deps, "pin", 1, 1);
    requestGeometry(deps, "hover", 4, 4);
    requestGeometry(deps, "select", 9, 7);

    expect(kernel.dispatched).toHaveLength(1);
    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "pin-anchor", uuidv7()),
    );
    expect(deps.local.overlay()).toBeNull();
    expect(kernel.dispatched).toHaveLength(2);
    expect((kernel.dispatched[1] as { payload: unknown }).payload).toEqual({
      frameToken: uiFrame.frameToken,
      query: { kind: "hit", x: 9, y: 7 },
    });
  });

  test("a dispatch Error releases the flight through runtimeError for a later request", async () => {
    const { deps, kernel, uiFrame } = harness();
    const dispatchError = new Error("geometry dispatch failed");
    acknowledgeFrame(deps, uiFrame);
    kernel.setDispatchResult(dispatchError);

    requestGeometry(deps, "hover", 1, 2);
    await tick();

    expect(deps.runtimeError()).toBe(dispatchError);
    expect(deps.interaction.pendingGeometry()).toBeNull();

    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7(),
      status: "accepted",
      acceptedRevision: "0",
      resultingRevision: "0",
      disposition: "completed",
    });
    requestGeometry(deps, "hover", 3, 4);
    expect(kernel.dispatched).toHaveLength(2);
  });

  test("a rejected geometry command also releases the flight through runtimeError", async () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7(),
      status: "rejected",
      currentRevision: "1",
      code: "TURN_RUNNING",
      reasons: [{ code: "TURN_RUNNING", turnId: uuidv7() }],
    });

    requestGeometry(deps, "hover", 1, 2);
    await tick();

    expect(deps.runtimeError()).toBeInstanceOf(Error);
    expect(deps.interaction.pendingGeometry()).toBeNull();
  });

  test("does not reuse an acknowledged token after a newer frame becomes current", () => {
    const { deps, kernel, preview, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    const newer = { ...uiFrame.frame, frameSeq: "2" };
    preview.pushFrame(newer);
    deps.previewFrame.set({
      frame: newer,
      frameToken: preview.frameTokenFor(newer),
      handle: preview.handle,
    });

    requestGeometry(deps, "pin", 4, 5);

    expect(kernel.dispatched).toHaveLength(0);
  });

  test("keeps mutation queries inert in read-only while allowing hover geometry", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        trust: "untrusted-read-only",
      }),
    );

    requestGeometry(deps, "select", 1, 2);
    requestGeometry(deps, "pin", 1, 2);
    requestGeometry(deps, "hover", 1, 2);

    expect(kernel.dispatched.map((raw) => (raw as { kind: string }).kind)).toEqual([
      "preview.queryGeometry",
    ]);
  });

  test("only the matching token and query kind may open pin input", () => {
    const { deps, uiFrame } = harness();
    const geometryToken = uuidv7();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "pin", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uuidv7(), "pin-anchor", geometryToken),
    );
    expect(deps.local.overlay()).toBeNull();

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", geometryToken),
    );
    expect(deps.local.overlay()).toBeNull();

    handleGeometryResult(
      deps,
      geometryEvent(
        uiFrame.handle.previewSessionId,
        uiFrame.frameToken,
        "pin-anchor",
        geometryToken,
      ),
    );
    expect(deps.local.overlay()).toBe("pin-input");
  });

  /**
   * A `checkHit` names ONE thing — the element under the cursor (§7.1). The page half of a
   * selection comes from the shell's own active page, and the rectangle from the frame's
   * element-rect map; neither was ever on the wire.
   */
  test("an unresolved hit selects nothing and clears what was selected", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "select", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null, null),
    );

    expect(deps.interaction.selectionRect()).toBeNull();
    expect(deps.interaction.hover()).toBeNull();
    expect(kernel.dispatched.map((raw) => (raw as { kind: string }).kind)).toEqual([
      "preview.queryGeometry",
    ]);
  });

  test("a resolved hit selects that element on the active page", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "select", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );

    const selection = kernel.dispatched.find(
      (raw) => (raw as { kind: string }).kind === "selection.set",
    );
    expect((selection as { payload: unknown } | undefined)?.payload).toEqual({
      pageSlug: "main",
      elementId: "network",
    });
  });

  test("highlights the hit element's own rectangle, taken from this frame's element rects", () => {
    const { deps, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    deps.interaction.elementRects.set({
      frameToken: uiFrame.frameToken,
      rects: new Map([["network", { x: 3, y: 2, width: 8, height: 4 }]]),
    });
    requestGeometry(deps, "hover", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );

    expect(deps.interaction.hover()).toEqual({
      rect: { x: 3, y: 2, width: 8, height: 4 },
      // The element id stands in for the design's `panel "network"` label — see the
      // divergence note in `handleGeometryResult`.
      label: "network",
    });
  });

  test("selects an element whose rectangle has not landed yet, with no corner glyphs to draw", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "select", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );

    // No rects for this frame yet: the chip still resolves, the corners simply wait.
    expect(deps.interaction.selectionRect()).toBeNull();
    expect(
      kernel.dispatched.some((raw) => (raw as { kind: string }).kind === "selection.set"),
    ).toBe(true);
  });

  test("a superseded pin result cannot open a popup after hover becomes latest", () => {
    const { deps, uiFrame } = harness();
    const geometryToken = uuidv7();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "pin", 2, 3);
    requestGeometry(deps, "hover", 4, 5);

    handleGeometryResult(
      deps,
      geometryEvent(
        uiFrame.handle.previewSessionId,
        uiFrame.frameToken,
        "pin-anchor",
        geometryToken,
      ),
    );

    expect(deps.local.overlay()).toBeNull();
    expect(deps.interaction.pendingPin()).toBeNull();
  });
});

describe("preview element-rect lane", () => {
  const layoutEvent = (previewSessionId: UUIDv7, frameTokenId: FrameTokenV1, tree: LayoutNodeV1) =>
    event("preview.geometryResult", {
      previewSessionId,
      frameTokenId,
      frameIdentity: { previewSessionId, nonce: TEST_NONCE, sourceHash: TEST_SHA, frameSeq: "1" },
      queryKind: "layout",
      result: { kind: "layoutTree", tree },
      geometryToken: null,
    });

  const tree = (id: string): LayoutNodeV1 => ({
    id: "root",
    kind: "BoxRenderable",
    box: { x: 0, y: 0, width: 20, height: 10 },
    children: [
      { id, kind: "TextRenderable", box: { x: 3, y: 2, width: 8, height: 1 }, children: [] },
    ],
  });

  test("asks for the whole layout tree once the frame is display-acknowledged", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestElementRects(deps);

    expect(kernel.dispatched).toHaveLength(1);
    expect(kernel.dispatched[0]).toMatchObject({
      kind: "preview.queryGeometry",
      payload: { frameToken: uiFrame.frameToken, query: { kind: "layout" } },
    });
  });

  test("does not ask before the frame is display-acknowledged", () => {
    const { deps, kernel } = harness();
    requestElementRects(deps);

    expect(kernel.dispatched).toHaveLength(0);
  });

  test("is idempotent — repeated calls neither re-ask in flight nor re-ask once resolved", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestElementRects(deps);
    requestElementRects(deps);
    expect(kernel.dispatched).toHaveLength(1);

    handleGeometryResult(
      deps,
      layoutEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, tree("digital-time")),
    );
    requestElementRects(deps);

    expect(kernel.dispatched).toHaveLength(1);
    expect(deps.interaction.elementRects()?.rects.get("digital-time")).toEqual({
      x: 3,
      y: 2,
      width: 8,
      height: 1,
    });
  });

  test("a pointer query in flight neither supersedes the layout query nor is superseded by it", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);

    requestGeometry(deps, "hover", 1, 1);
    requestElementRects(deps);

    // Two lanes, two commands — the hover request did not take the layout query's slot.
    expect(kernel.dispatched).toHaveLength(2);
    handleGeometryResult(
      deps,
      layoutEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, tree("gauge-cpu")),
    );

    expect(deps.interaction.elementRects()?.rects.has("gauge-cpu")).toBe(true);
    // …and the hover request is still the pending one on its own lane.
    expect(deps.interaction.pendingGeometry()?.purpose).toBe("hover");
  });

  test("drops a reply about a frame that is no longer displayed", () => {
    const { deps, kernel, preview, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestElementRects(deps);
    expect(kernel.dispatched).toHaveLength(1);

    const newer = { ...frame(preview.handle.previewSessionId), frameSeq: "2" };
    preview.pushFrame(newer);
    const newerUiFrame = {
      frame: newer,
      frameToken: preview.frameTokenFor(newer),
      handle: preview.handle,
    };
    deps.previewFrame.set(newerUiFrame);
    acknowledgeFrame(deps, newerUiFrame);

    handleGeometryResult(
      deps,
      layoutEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, tree("digital-time")),
    );

    expect(deps.interaction.elementRects()).toBeNull();
  });

  test("a newly acknowledged frame drops the previous frame's rectangles rather than reusing them", () => {
    const { deps, preview, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestElementRects(deps);
    handleGeometryResult(
      deps,
      layoutEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, tree("digital-time")),
    );
    expect(deps.interaction.elementRects()).not.toBeNull();

    const newer = { ...frame(preview.handle.previewSessionId), frameSeq: "2" };
    preview.pushFrame(newer);
    const newerUiFrame = {
      frame: newer,
      frameToken: preview.frameTokenFor(newer),
      handle: preview.handle,
    };
    deps.previewFrame.set(newerUiFrame);
    acknowledgeFrame(deps, newerUiFrame);

    expect(deps.interaction.elementRects()).toBeNull();
    expect(deps.interaction.pendingElementRects()).toBeNull();
  });

  test("a refused query clears the lane so the next render retries", async () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7(),
      status: "rejected",
      currentRevision: "1",
      code: "OPERATION_BUSY",
      reasons: [{ code: "OPERATION_BUSY" }],
    });

    requestElementRects(deps);
    await tick();
    expect(deps.interaction.pendingElementRects()).toBeNull();

    requestElementRects(deps);

    expect(kernel.dispatched).toHaveLength(2);
  });
});

describe("frameLocalPoint", () => {
  test("subtracts the absolute frame origin once and clamps to frame cells", () => {
    expect(
      frameLocalPoint({
        absolute: { x: 5, y: 2 },
        frameRect: { x: 10, y: 4, width: 20, height: 8 },
      }),
    ).toEqual({ x: 0, y: 0 });
    expect(
      frameLocalPoint({
        absolute: { x: 50, y: 30 },
        frameRect: { x: 10, y: 4, width: 20, height: 8 },
      }),
    ).toEqual({ x: 19, y: 7 });
    expect(
      frameLocalPoint({
        absolute: { x: 14, y: 9 },
        frameRect: { x: 10, y: 4, width: 20, height: 8 },
      }),
    ).toEqual({ x: 4, y: 5 });
  });
});

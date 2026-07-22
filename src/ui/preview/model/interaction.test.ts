import { beforeEach, describe, expect, test } from "bun:test";

import type { PreviewFrameV1 } from "core/ports";
import type { FrameTokenV1, GeometryTokenV1, UUIDv7 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import {
  acknowledgeFrame,
  frameLocalPoint,
  handleGeometryResult,
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
    result: {
      pageSlug: "main",
      elementId: "network",
      rect: { x: 3, y: 2, width: 8, height: 3 },
      label: 'panel "network"',
    },
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

  test("hover to select ignores the first hit and applies only the promoted latest hit", () => {
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

    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );
    expect(deps.interaction.hover()).toEqual({
      rect: { x: 3, y: 2, width: 8, height: 3 },
      label: 'panel "network"',
    });
    expect(deps.interaction.selectionRect()).toEqual({ x: 3, y: 2, width: 8, height: 3 });
    expect((kernel.dispatched[2] as { kind: string }).kind).toBe("selection.set");
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

  test("a selected hit dispatches selection.set only after structural narrowing", () => {
    const { deps, kernel, uiFrame } = harness();
    acknowledgeFrame(deps, uiFrame);
    requestGeometry(deps, "select", 4, 5);

    const malformed = geometryEvent(
      uiFrame.handle.previewSessionId,
      uiFrame.frameToken,
      "hit",
      null,
    );
    handleGeometryResult(deps, {
      ...malformed,
      payload: { ...malformed.payload, result: { rect: "not-a-rect" } },
    });
    expect(kernel.dispatched.map((raw) => (raw as { kind: string }).kind)).toEqual([
      "preview.queryGeometry",
    ]);

    requestGeometry(deps, "select", 4, 5);
    handleGeometryResult(
      deps,
      geometryEvent(uiFrame.handle.previewSessionId, uiFrame.frameToken, "hit", null),
    );
    const selection = kernel.dispatched[2] as { kind: string; payload: unknown };
    expect(selection.kind).toBe("selection.set");
    expect(selection.payload).toEqual({ pageSlug: "main", elementId: "network" });
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

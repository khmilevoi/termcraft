import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";

import type { PreviewFrameV1, PreviewIdentityV1 } from "../preview-session";
import { createFakePreviewSession } from "./preview-session";

const identity: PreviewIdentityV1 = {
  mode: "preview",
  pageSlug: "home",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  sessionId: "sess-1",
};

const FAILURE: FailureDtoV1 = {
  code: "HOST_PROTOCOL_FAILED",
  retryable: true,
  safeMessage: "host disconnected",
  details: {},
};

function frame(frameSeq: string): PreviewFrameV1 {
  return {
    sessionId: "sess-1",
    sourceHash: identity.sourceHash,
    frameSeq,
    width: 80,
    height: 24,
    rows: [],
  };
}

describe("createFakePreviewSession", () => {
  test("starts with the constructed identity and static interaction mode", () => {
    const session = createFakePreviewSession(identity);
    expect(session.identity).toBe(identity);
    expect(session.mode).toBe("preview");
    expect(session.interactionMode).toBe("static");
  });

  test("setMode() changes interactionMode only on an accepted response, never optimistically", async () => {
    const session = createFakePreviewSession(identity);
    session.failNext("setMode", FAILURE);
    const rejected = await session.setMode("interactive");
    expect(rejected).toEqual(FAILURE);
    expect(session.interactionMode).toBe("static");

    const accepted = await session.setMode("interactive");
    expect(accepted).toBeUndefined();
    expect(session.interactionMode).toBe("interactive");
  });

  test("emitFrame() delivers frames through the async iterable until close()", async () => {
    const session = createFakePreviewSession(identity);
    session.emitFrame(frame("1"));
    session.emitFrame(frame("2"));
    session.close();

    const seen: string[] = [];
    for await (const f of session.frames) {
      seen.push(f.frameSeq);
    }
    expect(seen).toEqual(["1", "2"]);
  });

  test("query() defaults to an unresolved geometry result", async () => {
    const session = createFakePreviewSession(identity);
    const result = await session.query("token-1", { kind: "layout" });
    if ("code" in result) throw new Error("unexpected failure");
    expect(result.resolvedAnchor).toBeNull();
  });

  test("queueQueryResult() scripts a resolved anchor for the next query(), one shot", async () => {
    const session = createFakePreviewSession(identity);
    session.queueQueryResult({
      result: {},
      resolvedAnchor: { pageSlug: "home", elementId: "btn-1", fx: 0.5, fy: 0.5 },
    });
    const first = await session.query("token-1", { kind: "hit", x: 1, y: 1 });
    if ("code" in first) throw new Error("unexpected failure");
    expect(first.resolvedAnchor).toEqual({
      pageSlug: "home",
      elementId: "btn-1",
      fx: 0.5,
      fy: 0.5,
    });
    const second = await session.query("token-1", { kind: "hit", x: 1, y: 1 });
    if ("code" in second) throw new Error("unexpected failure");
    expect(second.resolvedAnchor).toBeNull();
  });

  test("records calls across methods in order", async () => {
    const session = createFakePreviewSession(identity);
    await session.resize({ w: 100, h: 30 });
    await session.retry();
    session.close();
    expect(session.calls.map((c) => c.method)).toEqual(["resize", "retry", "close"]);
  });
});

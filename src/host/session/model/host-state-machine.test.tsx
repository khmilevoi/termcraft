import { afterEach, describe, expect, test } from "bun:test";

import { DARK_DEFAULT, themeIdAtom, themeTokensAtom } from "runtime/model/tokens";

import {
  type ClientHelloV1,
  type ControlEnvelope,
  type FrameEnvelope,
  type HostHelloV1,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  type PublicLimits,
  type RuntimeDeclarationBundleV1,
  encodeClientHello,
  encodeControlEnvelope,
} from "../../protocol";
import {
  type LayoutNode,
  type RenderHandle,
  type RenderSize,
  createHeadlessRenderer,
} from "../../render";
import type { HostSessionDeps, OutboundMessage } from "../types";
import { createHostSession } from "./host-state-machine";

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
};

const SESSION_ID = "01920000-0000-7000-8000-000000000000";
const NONCE = "0123456789abcdef0123456789abcdef";

const clientHello = (over: Partial<ClientHelloV1> = {}): ClientHelloV1 => ({
  framingVersion: 1,
  kind: "client.hello",
  sessionId: SESSION_ID,
  nonce: NONCE,
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "dashboard",
  sourceHash: "a".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: RUNTIME_DECLARATION,
  limits: PROTOCOL_HARD_LIMITS,
  ...over,
});

interface Harness {
  readonly out: OutboundMessage[];
  readonly exits: { code: number; reason: string }[];
  readonly deps: HostSessionDeps;
}

function harness(over: Partial<HostSessionDeps> = {}): Harness {
  const out: OutboundMessage[] = [];
  const exits: { code: number; reason: string }[] = [];
  const deps: HostSessionDeps = {
    runtimeDeclaration: RUNTIME_DECLARATION,
    limits: PROTOCOL_HARD_LIMITS,
    loadPage: async () => ({
      meta: { kitApiVersion: 1, title: "t", minSize: { w: 4, h: 1 }, theme: "dark-default" },
      component: () => null,
      sourceHash: "a".repeat(64),
    }),
    // The honest default for a fixture that does not care about themes (design-systems §4.6,
    // task 5 step 7): no design system, no seed — never a fabricated one.
    loadThemeSeed: async () => null,
    createRenderer: async () => {
      throw new Error("not used in this task");
    },
    now: () => 1000,
    send: (m) => out.push(m),
    requestExit: (r) => exits.push(r),
    ...over,
  };
  return { out, exits, deps };
}

// Encode a client.hello to the raw control payload the state machine decodes.
function helloPayload(hello: ClientHelloV1): Uint8Array {
  const framed = encodeClientHello(hello);
  if (framed instanceof Error) throw framed;
  // encodeClientHello prepends the 8-byte frame header; the state machine
  // receives the PAYLOAD (the entry strips the header via FrameDecoder).
  return framed.slice(8);
}

describe("host session — handshake", () => {
  test("answers a valid client.hello with a host.hello echoing identity", async () => {
    const h = harness();
    const session = createHostSession(h.deps);
    await session.receiveControlPayload(helloPayload(clientHello()));

    expect(h.out).toHaveLength(1);
    const first = h.out[0]!;
    expect(first.type).toBe("host-hello");
    const hello = (first as { payload: HostHelloV1 }).payload;
    expect(hello.kind).toBe("host.hello");
    expect(hello.sessionId).toBe(SESSION_ID);
    expect(hello.nonce).toBe(NONCE);
    expect(hello.selectedFramingVersion).toBe(1);
    expect(hello.selectedProtocolVersion).toBe(1);
    expect(hello.runtimeDeclaration).toEqual(RUNTIME_DECLARATION);
  });

  test("negotiates limits to the per-field minimum of client and host", async () => {
    const h = harness();
    const session = createHostSession(h.deps);
    const stricter: PublicLimits = { ...PROTOCOL_HARD_LIMITS, maxFrameWidth: 100 };
    await session.receiveControlPayload(helloPayload(clientHello({ limits: stricter })));
    const hello = (h.out[0] as { payload: HostHelloV1 }).payload;
    expect(hello.limits.maxFrameWidth).toBe(100);
    expect(hello.limits.controlPayloadBytes).toBe(PROTOCOL_HARD_LIMITS.controlPayloadBytes);
  });

  test("a malformed client.hello requests exit and emits no host.hello", async () => {
    const h = harness();
    const session = createHostSession(h.deps);
    await session.receiveControlPayload(new TextEncoder().encode("{ not json"));
    expect(h.out).toHaveLength(0);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(1);
  });
});

let liveRenderer: RenderHandle | null = null;
afterEach(() => {
  liveRenderer?.destroy();
  liveRenderer = null;
});

const FixtureComponent = () => (
  <box>
    <text>mounted-ok</text>
  </box>
);

function mountEnvelope(
  over: Partial<ControlEnvelope["body"]> = {},
  sessionId = SESSION_ID,
  nonce = NONCE,
  requestId = "1",
): Uint8Array {
  const envelope: ControlEnvelope = {
    protocolVersion: 1,
    kind: "mount",
    sessionId,
    nonce,
    messageId: "1",
    requestId,
    body: {
      treeRoot: "/unused/in/fake/loadPage/design",
      entryRelPath: "pages/home.tsx",
      expectedFiles: [{ relPath: "pages/home.tsx", sha256: "a".repeat(64) }],
      mode: "preview",
      interactionMode: "static",
      size: { w: 16, h: 3 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
      deterministic: true,
      ...over,
    },
  };
  const framed = encodeControlEnvelope(envelope);
  if (framed instanceof Error) throw framed;
  return framed.slice(8);
}

async function handshaken(over: Partial<HostSessionDeps> = {}) {
  const h = harness({
    createRenderer: (size) => {
      return createHeadlessRenderer(size).then((r) => {
        liveRenderer = r;
        return r;
      });
    },
    loadPage: async () => ({
      meta: {
        kitApiVersion: 1,
        title: "Dashboard",
        minSize: { w: 16, h: 3 },
        theme: "dark-default",
      },
      component: FixtureComponent,
      sourceHash: "a".repeat(64),
    }),
    ...over,
  });
  const session = createHostSession(h.deps);
  await session.receiveControlPayload(helloPayload(clientHello()));
  h.out.length = 0; // drop the host.hello
  return { h, session };
}

describe("host session — mount", () => {
  test("mount emits ready then the first frame, both under one identity", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope());

    expect(h.out).toHaveLength(2);
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload;
    expect(ready.kind).toBe("ready");
    expect(ready.responseTo).toBe("1");
    expect(ready.sessionId).toBe(SESSION_ID);
    const readyBody = ready.body as unknown as {
      meta: { title: string };
      size: { w: number; h: number };
      interactionMode: string;
      frameIdentity: { frameSeq: string; sourceHash: string };
    };
    expect(readyBody.meta.title).toBe("Dashboard");
    expect(readyBody.size).toEqual({ w: 16, h: 3 });
    expect(readyBody.interactionMode).toBe("static");
    expect(readyBody.frameIdentity.frameSeq).toBe("1");

    const frame = (h.out[1] as { payload: FrameEnvelope }).payload;
    expect(frame.kind).toBe("frame");
    expect(frame.frameSeq).toBe("1");
    expect(frame.width).toBe(16);
    expect(frame.sourceHash).toBe("a".repeat(64));
    expect((frame.rows[0] ?? []).map((r) => r.text).join("")).toContain("mounted-ok");
  });

  test("preview mount stays alive (no exit)", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope());
    expect(h.exits).toHaveLength(0);
  });

  test("smoke mount emits ready+frame then exits 0 (one-shot)", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope({ mode: "smoke" }));
    expect(h.out).toHaveLength(2);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(0);
  });

  test("a non-preview mount forces effective static even if interactive requested", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(
      mountEnvelope({ mode: "historical", interactionMode: "interactive" }),
    );
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload;
    expect((ready.body as unknown as { interactionMode: string }).interactionMode).toBe("static");
  });

  test("a loadPage failure emits a typed error and exits", async () => {
    const { h, session } = await handshaken({
      loadPage: async () =>
        new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "source hash mismatch" }),
    });
    await session.receiveControlPayload(mountEnvelope());
    const errorMsg = h.out.find(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
    );
    expect(errorMsg).toBeDefined();
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(1);
  });

  /**
   * REGRESSION (defect fix, 2026-07-27): a page component that throws used to reach `ready`
   * + a frame and exit 0, because `@opentui/react` catches the throw in its own boundary and
   * paints the stack trace — so `render()`/`capture()` both succeed. The gate's smoke stage
   * reads exactly that "did a frame come back" signal, so a completely broken page passed the
   * gate, the turn committed, and the chat reported success. `PAGE_RENDER_FAILED` is
   * deliberately NOT a `ProtocolViolationCode`: the supervisor maps unlisted codes to the
   * restartable `DESIGN_RENDER_FAILED`, which is what a bad candidate is.
   */
  test("a page that throws while rendering emits PAGE_RENDER_FAILED instead of ready+frame", async () => {
    const { h, session } = await handshaken({
      loadPage: async () => ({
        meta: {
          kitApiVersion: 1,
          title: "Dashboard",
          minSize: { w: 16, h: 3 },
          theme: "dark-default",
        },
        component: function Broken(): never {
          throw new TypeError("ctx.spy is not a function");
        },
        sourceHash: "a".repeat(64),
      }),
    });
    await session.receiveControlPayload(mountEnvelope());

    const error = h.out.find(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
    ) as { payload: ControlEnvelope } | undefined;
    expect(error).toBeDefined();
    expect((error!.payload.body as { code: string }).code).toBe("PAGE_RENDER_FAILED");
    expect((error!.payload.body as { reason: string }).reason).toContain(
      "ctx.spy is not a function",
    );
    expect(
      h.out.some(
        (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "ready",
      ),
    ).toBe(false);
    expect(h.out.some((m) => m.type === "frame")).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(1);
  });

  test("an inbound envelope with the wrong nonce is fatal", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope({}, SESSION_ID, "f".repeat(32)));
    expect(h.exits).toHaveLength(1);
  });

  test("a mount whose size exceeds the negotiated cell cap is refused with FRAME_TOO_LARGE", async () => {
    const { h, session } = await handshaken();
    // 600×600 = 360,000 cells > maxFrameCells (262,144), yet each axis is ≤ 2048.
    // The host must refuse rather than render and emit a self-rejecting frame (§5.3).
    await session.receiveControlPayload(mountEnvelope({ size: { w: 600, h: 600 } }));
    const error = h.out.find(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
    ) as { payload: ControlEnvelope } | undefined;
    expect(error).toBeDefined();
    expect((error!.payload.body as { code: string }).code).toBe("FRAME_TOO_LARGE");
    expect(h.out.some((m) => m.type === "frame")).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(1);
  });
});

/**
 * Wraps the real headless renderer with call counters and a one-shot forced `renderError()`,
 * so re-mount tests can observe "was the SAME renderer reused" and "did this specific mount
 * fail" without a second fake `RenderHandle` (design §9.2, phase-3 task 1).
 */
function trackingRendererFactory() {
  const createdRenderers: RenderHandle[] = [];
  const resizeCalls: RenderSize[] = [];
  let mountCallCount = 0;
  let forcedRenderError: Error | null = null;

  const createRenderer = async (size: RenderSize): Promise<RenderHandle> => {
    const real = await createHeadlessRenderer(size);
    liveRenderer = real;
    const tracked: RenderHandle = {
      ...real,
      mount(node) {
        mountCallCount += 1;
        real.mount(node);
      },
      resize(next) {
        resizeCalls.push(next);
        real.resize(next);
      },
      renderError() {
        if (forcedRenderError !== null) {
          const error = forcedRenderError;
          forcedRenderError = null;
          return error;
        }
        return real.renderError();
      },
    };
    createdRenderers.push(tracked);
    return tracked;
  };

  return {
    createRenderer,
    createdRenderers,
    resizeCalls,
    mountCallCount: () => mountCallCount,
    forceNextRenderError: (error: Error) => {
      forcedRenderError = error;
    },
  };
}

/** `loadPage` stub that answers a different `sourceHash` per `entryRelPath` (re-mount tests). */
function loadPageByEntry(hashes: Record<string, string>) {
  return async ({ entryRelPath }: { entryRelPath: string }) => ({
    meta: {
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 16, h: 3 },
      theme: "dark-default",
    },
    component: FixtureComponent,
    sourceHash: hashes[entryRelPath] ?? "a".repeat(64),
  });
}

describe("host session — ready-phase re-mount (design §9.2)", () => {
  const A_HASH = "a".repeat(64);
  const B_HASH = "b".repeat(64);

  test("a second mount in the ready phase is accepted and re-mounts the live renderer", async () => {
    const tracker = trackingRendererFactory();
    const { h, session } = await handshaken({ createRenderer: tracker.createRenderer });
    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/a.tsx" }, SESSION_ID, NONCE, "1"),
    );
    const rendererCount = tracker.createdRenderers.length;

    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/b.tsx" }, SESSION_ID, NONCE, "2"),
    );

    // exactly one renderer for the whole incarnation
    expect(tracker.createdRenderers.length).toBe(rendererCount);
    // the live handle was told to replace its tree
    expect(tracker.mountCallCount()).toBe(2);
    // the ready response correlates to the SECOND request
    const readyMessages = h.out.filter(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "ready",
    ) as { payload: ControlEnvelope }[];
    expect(readyMessages.at(-1)?.payload.responseTo).toBe("2");
  });

  test("frames after a re-mount carry the new page's source hash and a higher frameSeq", async () => {
    const tracker = trackingRendererFactory();
    const { h, session } = await handshaken({
      createRenderer: tracker.createRenderer,
      loadPage: loadPageByEntry({ "pages/a.tsx": A_HASH, "pages/b.tsx": B_HASH }),
    });
    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/a.tsx" }, SESSION_ID, NONCE, "1"),
    );
    const first = (h.out.filter((m) => m.type === "frame").at(-1) as { payload: FrameEnvelope })
      .payload;

    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/b.tsx" }, SESSION_ID, NONCE, "2"),
    );
    const second = (h.out.filter((m) => m.type === "frame").at(-1) as { payload: FrameEnvelope })
      .payload;

    expect(first.sourceHash).toBe(A_HASH);
    expect(second.sourceHash).toBe(B_HASH);
    expect(BigInt(second.frameSeq) > BigInt(first.frameSeq)).toBe(true);
  });

  test("a re-mount at a different size resizes the live renderer, it does not rebuild it", async () => {
    const tracker = trackingRendererFactory();
    const { h, session } = await handshaken({ createRenderer: tracker.createRenderer });
    await session.receiveControlPayload(
      mountEnvelope(
        { entryRelPath: "pages/a.tsx", size: { w: 80, h: 24 } },
        SESSION_ID,
        NONCE,
        "1",
      ),
    );
    await session.receiveControlPayload(
      mountEnvelope(
        { entryRelPath: "pages/b.tsx", size: { w: 100, h: 30 } },
        SESSION_ID,
        NONCE,
        "2",
      ),
    );

    expect(tracker.createdRenderers.length).toBe(1);
    expect(tracker.resizeCalls).toEqual([{ w: 100, h: 30 }]);
    const lastFrame = (h.out.filter((m) => m.type === "frame").at(-1) as { payload: FrameEnvelope })
      .payload;
    expect(lastFrame.width).toBe(100);
    expect(lastFrame.height).toBe(30);
  });

  test("a re-mount whose page throws while rendering fails that mount, not the earlier one", async () => {
    const tracker = trackingRendererFactory();
    const { h, session } = await handshaken({ createRenderer: tracker.createRenderer });
    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/a.tsx" }, SESSION_ID, NONCE, "1"),
    );
    tracker.forceNextRenderError(new Error("boom"));

    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/b.tsx" }, SESSION_ID, NONCE, "2"),
    );

    const errorMsg = h.out
      .filter(
        (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
      )
      .at(-1) as { payload: ControlEnvelope } | undefined;
    expect(errorMsg).toBeDefined();
    expect((errorMsg!.payload.body as { code: string }).code).toBe("PAGE_RENDER_FAILED");
    expect(h.exits.at(-1)?.code).toBe(1);
  });

  test("a smoke mount still exits after its first frame and never accepts a second", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/a.tsx", mode: "smoke" }, SESSION_ID, NONCE, "1"),
    );
    expect(h.exits.at(-1)?.code).toBe(0);

    await session.receiveControlPayload(
      mountEnvelope({ entryRelPath: "pages/b.tsx", mode: "smoke" }, SESSION_ID, NONCE, "2"),
    );
    // phase is "closed": the payload is dropped, no second ready, no second exit request
    const readyMessages = h.out.filter(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "ready",
    );
    expect(readyMessages.length).toBe(1);
    expect(h.exits.length).toBe(1);
  });
});

describe("host session — export/smoke layout capture (WP-5 Task A1, D-Q8)", () => {
  test("an export mount seals a ready whose body carries the resolved layout tree", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope({ mode: "export" }));
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload;
    const readyBody = ready.body as unknown as { layout?: LayoutNode };
    expect(readyBody.layout).toBeDefined();
    expect(readyBody.layout).toEqual(liveRenderer!.layoutTree());
  });

  test("a smoke mount also seals a ready whose body carries the resolved layout tree", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope({ mode: "smoke" }));
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload;
    const readyBody = ready.body as unknown as { layout?: LayoutNode };
    expect(readyBody.layout).toBeDefined();
    expect(readyBody.layout).toEqual(liveRenderer!.layoutTree());
  });

  test("a preview mount's ready body carries no layout (regression)", async () => {
    const { h, session } = await handshaken();
    await session.receiveControlPayload(mountEnvelope());
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload;
    const readyBody = ready.body as unknown as { layout?: LayoutNode };
    expect(readyBody.layout).toBeUndefined();
  });
});

async function readied(over: Partial<HostSessionDeps> = {}) {
  const started = await handshaken(over);
  await started.session.receiveControlPayload(mountEnvelope());
  started.h.out.length = 0; // drop ready + first frame
  return started;
}

function controlEnvelope(
  kind: string,
  body: ControlEnvelope["body"],
  requestId?: string,
): Uint8Array {
  const envelope: ControlEnvelope = {
    protocolVersion: 1,
    kind,
    sessionId: SESSION_ID,
    nonce: NONCE,
    messageId: "9",
    ...(requestId !== undefined ? { requestId } : {}),
    body,
  };
  const framed = encodeControlEnvelope(envelope);
  if (framed instanceof Error) throw framed;
  return framed.slice(8);
}

const GeometryFixtureComponent = () => (
  <box id="panel">
    <text id="label">geo-ok</text>
  </box>
);

async function readiedWithGeometry() {
  return readied({
    loadPage: async () => ({
      meta: {
        kitApiVersion: 1,
        title: "Dashboard",
        minSize: { w: 16, h: 3 },
        theme: "dark-default",
      },
      component: GeometryFixtureComponent,
      sourceHash: "a".repeat(64),
    }),
  });
}

function queryEnvelope(
  kind: string,
  frameIdentity: Record<string, string>,
  extra: Record<string, unknown> = {},
  requestId = "20",
): Uint8Array {
  return controlEnvelope(kind, { frameIdentity, ...extra } as ControlEnvelope["body"], requestId);
}

describe("host session — ready-phase geometry queries (design doc §4.2, host-supervision §7.1)", () => {
  test("query-hit resolves a real element id at an in-bounds point under the current sealed frame", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      queryEnvelope(
        "query-hit",
        { sessionId: SESSION_ID, nonce: NONCE, sourceHash: "a".repeat(64), frameSeq: "1" },
        { x: 0, y: 0 },
      ),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    expect(response.kind).toBe("query-hit");
    expect(response.responseTo).toBe("20");
    const body = response.body as {
      ok: boolean;
      frameIdentity: { frameSeq: string };
      result: { elementId: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.frameIdentity.frameSeq).toBe("1");
    expect(body.result.elementId).not.toBeNull();
  });

  test("query-rect resolves the element's real box for a known id, and found:false for an unknown id", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      queryEnvelope(
        "query-rect",
        { sessionId: SESSION_ID, nonce: NONCE, sourceHash: "a".repeat(64), frameSeq: "1" },
        { elementId: "panel" },
      ),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    const body = response.body as {
      ok: boolean;
      result: { found: boolean; rect: { width: number; height: number } | null };
    };
    expect(body.ok).toBe(true);
    expect(body.result.found).toBe(true);
    expect(body.result.rect?.width).toBeGreaterThan(0);

    h.out.length = 0;
    await session.receiveControlPayload(
      queryEnvelope(
        "query-rect",
        { sessionId: SESSION_ID, nonce: NONCE, sourceHash: "a".repeat(64), frameSeq: "1" },
        { elementId: "missing" },
        "21",
      ),
    );
    const missResponse = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    const missBody = missResponse.body as {
      ok: boolean;
      result: { found: boolean; rect: unknown };
    };
    expect(missBody.ok).toBe(true);
    expect(missBody.result.found).toBe(false);
    expect(missBody.result.rect).toBeNull();
  });

  test("query-describe resolves the real underlying kind for a known id", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      queryEnvelope(
        "query-describe",
        { sessionId: SESSION_ID, nonce: NONCE, sourceHash: "a".repeat(64), frameSeq: "1" },
        { elementId: "label" },
      ),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    const body = response.body as { ok: boolean; result: { found: boolean; kind: string | null } };
    expect(body.ok).toBe(true);
    expect(body.result.found).toBe(true);
    expect(typeof body.result.kind).toBe("string");
  });

  test("query-layout resolves the real mounted tree including both stable ids", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      queryEnvelope("query-layout", {
        sessionId: SESSION_ID,
        nonce: NONCE,
        sourceHash: "a".repeat(64),
        frameSeq: "1",
      }),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    interface TreeNode {
      id: string;
      children: TreeNode[];
    }
    const body = response.body as unknown as { ok: boolean; result: { tree: TreeNode } };
    expect(body.ok).toBe(true);
    const ids: string[] = [];
    const collect = (node: TreeNode): void => {
      ids.push(node.id);
      for (const child of node.children) collect(child);
    };
    collect(body.result.tree);
    expect(ids).toContain("panel");
    expect(ids).toContain("label");
  });

  test("a query against a frameSeq that is no longer current is refused with STALE_FRAME, not fatal", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      queryEnvelope(
        "query-hit",
        { sessionId: SESSION_ID, nonce: NONCE, sourceHash: "a".repeat(64), frameSeq: "999" },
        { x: 0, y: 0 },
      ),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    const body = response.body as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("STALE_FRAME");
    expect(h.exits).toHaveLength(0); // a stale query is a normal typed refusal, not a protocol violation
  });

  test("a query-hit without a requestId is fatal (MALFORMED_PROTOCOL)", async () => {
    const { h, session } = await readiedWithGeometry();
    await session.receiveControlPayload(
      controlEnvelope("query-hit", {
        frameIdentity: {
          sessionId: SESSION_ID,
          nonce: NONCE,
          sourceHash: "a".repeat(64),
          frameSeq: "1",
        },
        x: 0,
        y: 0,
      }),
    );
    expect(h.exits).toHaveLength(1);
  });
});

describe("host session — ready-phase control", () => {
  test("resize re-renders, emits a new frame with an incremented frameSeq, and sends a correlated ok response", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(controlEnvelope("resize", { size: { w: 24, h: 4 } }, "7"));
    const frames = h.out.filter((m) => m.type === "frame") as { payload: FrameEnvelope }[];
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.frameSeq).toBe("2");
    expect(frames[0]!.payload.width).toBe(24);

    const control = h.out.filter((m) => m.type === "control") as { payload: ControlEnvelope }[];
    expect(control).toHaveLength(1);
    expect(control[0]!.payload.kind).toBe("resize");
    expect(control[0]!.payload.responseTo).toBe("7");
    expect((control[0]!.payload.body as { ok: boolean }).ok).toBe(true);
  });

  test("a resize without a requestId is fatal (MALFORMED_PROTOCOL)", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(controlEnvelope("resize", { size: { w: 24, h: 4 } }));
    const error = h.out.find(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
    ) as { payload: ControlEnvelope } | undefined;
    expect(error).toBeDefined();
    expect((error!.payload.body as { code: string }).code).toBe("MALFORMED_PROTOCOL");
    expect(h.exits).toHaveLength(1);
  });

  test("a resize whose size exceeds the negotiated cell cap is refused with FRAME_TOO_LARGE", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(
      controlEnvelope("resize", { size: { w: 600, h: 600 } }, "8"),
    );
    const error = h.out.find(
      (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
    ) as { payload: ControlEnvelope } | undefined;
    expect(error).toBeDefined();
    expect((error!.payload.body as { code: string }).code).toBe("FRAME_TOO_LARGE");
    expect(h.out.some((m) => m.type === "frame")).toBe(false);
    expect(h.exits).toHaveLength(1);
  });

  test("ping gets a correlated ok response echoing kind ping", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(controlEnvelope("ping", {}, "5"));
    const control = h.out.filter((m) => m.type === "control") as { payload: ControlEnvelope }[];
    expect(control).toHaveLength(1);
    expect(control[0]!.payload.kind).toBe("ping");
    expect(control[0]!.payload.responseTo).toBe("5");
    expect((control[0]!.payload.body as { ok: boolean }).ok).toBe(true);
  });

  test("set-mode to interactive is accepted in preview and echoes the effective mode", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(
      controlEnvelope("set-mode", { interactionMode: "interactive" }, "6"),
    );
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope })
      .payload;
    expect(response.kind).toBe("set-mode");
    expect(response.responseTo).toBe("6");
    expect((response.body as { ok: boolean; interactionMode: string }).ok).toBe(true);
    expect((response.body as { interactionMode: string }).interactionMode).toBe("interactive");
  });

  test("set-mode to interactive is refused for a historical mount", async () => {
    // A historical mount ONLY — no extra `readied()` preview renderer to leak
    // (a leaked live OpenTUI renderer is the Spike-D hang condition).
    const historical = await handshaken();
    await historical.session.receiveControlPayload(mountEnvelope({ mode: "historical" }));
    historical.h.out.length = 0;
    await historical.session.receiveControlPayload(
      controlEnvelope("set-mode", { interactionMode: "interactive" }, "7"),
    );
    const response = (
      historical.h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }
    ).payload;
    expect((response.body as { ok: boolean }).ok).toBe(false);
    expect((response.body as { code: string }).code).toBe("HISTORICAL_PREVIEW_READ_ONLY");
  });

  test("emitHeartbeat sends a heartbeat carrying the last frameSeq", async () => {
    const { h, session } = await readied();
    session.emitHeartbeat();
    const beat = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload;
    expect(beat.kind).toBe("heartbeat");
    expect((beat.body as { lastFrameSeq: string }).lastFrameSeq).toBe("1");
    expect(typeof (beat.body as { hostTick: number }).hostTick).toBe("number");
  });

  test("shutdown acks then requests exit 0", async () => {
    const { h, session } = await readied();
    await session.receiveControlPayload(controlEnvelope("shutdown", {}, "8"));
    const ack = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload;
    expect(ack.kind).toBe("shutdown-ack");
    expect(ack.responseTo).toBe("8");
    expect(h.exits).toHaveLength(1);
    expect(h.exits[0]!.code).toBe(0);
  });
});

/**
 * The harness most recently built by {@link depsWith}. A single module-level pointer is safe
 * here (rather than threading an `out`/`exits` pair through every call site) because `bun test`
 * runs this file's tests one at a time, and every test below calls `depsWith` exactly once,
 * synchronously, right before building its own session — so there is never more than one
 * "current" harness in flight when {@link lastControlKind}/{@link lastFatalCode} read it back.
 */
let lastHarness: Harness | null = null;

/**
 * Build one theme-seed test's `HostSessionDeps` (design-systems §4.6, task 5's own test seam).
 * Defaults to a WORKING mount (a real headless renderer, a page that actually renders) so
 * `handshakeAndMount` below can reach `handle.mount(...)` — unlike the base `harness()`, whose
 * own `createRenderer` default deliberately throws for the handshake-only tests above.
 */
function depsWith(over: Partial<HostSessionDeps> = {}): HostSessionDeps {
  const h = harness({
    createRenderer: (size) =>
      createHeadlessRenderer(size).then((r) => {
        liveRenderer = r;
        return r;
      }),
    loadPage: async () => ({
      meta: {
        kitApiVersion: 1,
        title: "Dashboard",
        minSize: { w: 16, h: 3 },
        theme: "dark-default",
      },
      component: FixtureComponent,
      sourceHash: "a".repeat(64),
    }),
    ...over,
  });
  lastHarness = h;
  return h.deps;
}

/**
 * A real headless `RenderHandle` the ordering test can override `.mount` on directly (its `mount`
 * is a plain object property, not a class method, so reassignment works the same way
 * `trackingRendererFactory` above already relies on). Tracked as `liveRenderer` for this file's
 * shared `afterEach` cleanup.
 */
async function createFakeRenderHandle(size: RenderSize): Promise<RenderHandle> {
  const real = await createHeadlessRenderer(size);
  liveRenderer = real;
  return real;
}

/** Handshake, then mount — the two-step sequence every theme-seam test needs before it can
 * observe what `handleMount` did. */
async function handshakeAndMount(session: {
  receiveControlPayload(payload: Uint8Array): Promise<void>;
}): Promise<void> {
  await session.receiveControlPayload(helloPayload(clientHello()));
  await session.receiveControlPayload(mountEnvelope());
}

/** The `kind` of the last CONTROL message the session most recently built by {@link depsWith}
 * sent — `"ready"` for a clean mount, `"error"` for a fatal one. */
function lastControlKind(_session: unknown): string | undefined {
  const control = (lastHarness?.out.filter((m) => m.type === "control") ?? []) as {
    payload: ControlEnvelope;
  }[];
  return control.at(-1)?.payload.kind;
}

/** The `code` of the fatal `error` envelope the session most recently built by {@link depsWith}
 * sent, or `undefined` when none was sent. */
function lastFatalCode(_session: unknown): string | undefined {
  const errorMsg = lastHarness?.out.find(
    (m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error",
  ) as { payload: ControlEnvelope } | undefined;
  if (errorMsg === undefined) return undefined;
  return (errorMsg.payload.body as { code: string }).code;
}

describe("mount seeds the theme capability (design-systems §4.6)", () => {
  test("the child seeds BOTH theme atoms from the manifest before the tree is mounted", async () => {
    const seen: string[] = [];
    const session = createHostSession(
      depsWith({
        loadThemeSeed: async () => {
          seen.push("loadThemeSeed");
          return { themeId: "midnight", tokens: { ...DARK_DEFAULT, accent: "#4cc9f0" } };
        },
        createRenderer: async (size) => {
          const handle = await createFakeRenderHandle(size);
          const original = handle.mount;
          handle.mount = (element) => {
            seen.push("mount");
            // THE ORDERING ASSERTION, and it is the point of this test: a page's first render
            // must already see the project's palette. Reading the atom INSIDE `mount` is what
            // proves the seed landed before, not after.
            expect(themeIdAtom()).toBe("midnight");
            expect(themeTokensAtom().accent).toBe("#4cc9f0");
            return original(element);
          };
          return handle;
        },
      }),
    );
    await handshakeAndMount(session);
    expect(seen).toEqual(["loadThemeSeed", "mount"]);
  });

  test("a null seed leaves the compiled defaults in place and still mounts", async () => {
    const before = themeTokensAtom().accent;
    const session = createHostSession(depsWith({ loadThemeSeed: async () => null }));
    await handshakeAndMount(session);
    expect(themeTokensAtom().accent).toBe(before);
    expect(lastControlKind(session)).toBe("ready");
  });

  test("a loader failure fails the mount with the loader's own ProtocolError", async () => {
    const session = createHostSession(
      depsWith({
        loadThemeSeed: async () =>
          new ProtocolError({
            code: "SOURCE_HASH_MISMATCH",
            reason: "system/design-system.json drifted",
          }),
      }),
    );
    await handshakeAndMount(session);
    expect(lastFatalCode(session)).toBe("SOURCE_HASH_MISMATCH");
  });
});

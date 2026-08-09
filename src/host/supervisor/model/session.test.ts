import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionSpec } from "../../types";
import type {
  FloodMonitor,
  FrameBroker,
  HeartbeatWatchdog,
  HostSessionDeps,
  MountPageV1,
} from "../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { createFrameBroker } from "./frame-broker";
import { livePreviewChild } from "./preview-test-host";
import { REQUEST_TABLE_CAPACITY, createRequestTable } from "./request-table";
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child";
import type { ScriptedChild } from "./scripted-child";
import { createHostSession } from "./session";
import { FIRST_FRAME_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS, MOUNT_TIMEOUT_MS } from "./timeouts";
import { readInbound } from "./transport";

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};
const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dash",
  treeRoot: "/scratch/design",
  entryRelPath: "pages/dash.tsx",
  expectedFiles: [{ relPath: "pages/dash.tsx", sha256: "a".repeat(64) }],
  sourceHash: "a".repeat(64),
  treeRevision: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
};

// --- fixtures for the mount() suite (design §9.2): a second page in the SAME tree revision.
// One incarnation now serves one tree revision and mounts a page at a time, so `expectedFiles`
// must already carry every page that could be mounted during the incarnation's life — hence
// `specWithB` extends `spec`'s inventory rather than replacing it.
const PAGE_B_SOURCE_HASH = "b".repeat(64);
// Deliberately absent from every spec's `expectedFiles` — used to prove a frame naming a page
// this incarnation never mounted is still fatal, distinct from a legitimately mounted-then-
// superseded hash.
const PAGE_C_SOURCE_HASH = "c".repeat(64);

const specWithB: HostSessionSpec = {
  ...spec,
  expectedFiles: [...spec.expectedFiles, { relPath: "pages/b.tsx", sha256: PAGE_B_SOURCE_HASH }],
};

const pageB: MountPageV1 = {
  pageSlug: "b",
  entryRelPath: "pages/b.tsx",
  sourceHash: PAGE_B_SOURCE_HASH,
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  interactionMode: "static",
  theme: "dark-default",
};

/**
 * A responding fake host: decodes each supervisor write and emits the scripted
 * reply, so the supervisor's real drive loop runs end-to-end. Reads the
 * supervisor's minted sessionId/nonce off the client.hello it receives.
 */
function respondingChild(options?: {
  skipReady?: boolean;
  skipHello?: boolean;
  badAckIdentity?: boolean;
  /** Reply to the mount with a typed `error` envelope instead of ready+frame (design §12). */
  mountErrorCode?: string;
}): ScriptedChild {
  const child = createScriptedChild();
  let id: { sessionId: string; nonce: string } | null = null;
  let messageId = 1n;
  const nextId = () => {
    const value = messageId.toString();
    messageId += 1n;
    return value;
  };
  // decode writes through the shared inbound reader over a per-write mini stream
  child.onWrite = (bytes) => {
    void decodeWrite(bytes);
  };
  async function decodeWrite(bytes: Uint8Array) {
    // reuse readInbound over a throwaway child carrying just these bytes
    const carrier = createScriptedChild();
    carrier.emit(bytes);
    carrier.endStdout();
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return;
      if (message.messageClass === "control" && id === null) {
        // it's the client.hello — parse identity from raw JSON
        const parsed = JSON.parse(new TextDecoder().decode(message.payload)) as {
          sessionId: string;
          nonce: string;
          kind: string;
        };
        if (parsed.kind === "client.hello") {
          id = { sessionId: parsed.sessionId, nonce: parsed.nonce };
          if (options?.skipHello) return;
          const hostHello: HostHelloV1 = {
            framingVersion: 1,
            kind: "host.hello",
            sessionId: id.sessionId,
            nonce: id.nonce,
            selectedFramingVersion: 1,
            selectedProtocolVersion: 1,
            runtimeDeclaration,
            limits: PROTOCOL_HARD_LIMITS,
          };
          const framed = frameHostHello(hostHello);
          if (!(framed instanceof ProtocolError)) child.emit(framed);
          return;
        }
      }
      if (message.messageClass === "control" && id !== null) {
        const env = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope;
        if (env.kind === "mount" && options?.mountErrorCode !== undefined) {
          const error: ControlEnvelope = {
            protocolVersion: 1,
            kind: "error",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { code: options.mountErrorCode, reason: "render threw" },
          };
          const errorFramed = frameControl(error);
          if (!(errorFramed instanceof ProtocolError)) child.emit(errorFramed);
          return;
        }
        if (env.kind === "mount" && !options?.skipReady) {
          const ready: ControlEnvelope = {
            protocolVersion: 1,
            kind: "ready",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { size: { w: 80, h: 24 }, interactionMode: "static" },
          };
          const readyFramed = frameControl(ready);
          if (!(readyFramed instanceof ProtocolError)) child.emit(readyFramed);
          const frame: FrameEnvelope = {
            protocolVersion: 1,
            kind: "frame",
            sessionId: id.sessionId,
            nonce: id.nonce,
            sourceHash: spec.sourceHash,
            frameSeq: "1",
            width: 80,
            height: 24,
            // rows.length MUST equal height (decodeFrameEnvelope, frame.ts:92);
            // empty rows are valid — no run-width check exists.
            rows: Array.from({ length: 24 }, () => []),
          };
          const frameFramed = frameFrame(frame);
          if (!(frameFramed instanceof ProtocolError)) child.emit(frameFramed);
        }
        if (env.kind === "shutdown") {
          const ack: ControlEnvelope = {
            protocolVersion: 1,
            kind: "shutdown-ack",
            sessionId: id.sessionId,
            // A hostile/stale child can echo the correct responseTo but a WRONG
            // nonce — §5.2/§10.1 make that a fatal identity mismatch the supervisor
            // must reject (not accept as a graceful ack).
            nonce: options?.badAckIdentity ? "f".repeat(32) : id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { ok: true },
          };
          const framed = frameControl(ack);
          if (!(framed instanceof ProtocolError)) child.emit(framed);
          child.simulateExit({ code: 0 });
        }
      }
    }
  }
  return child;
}

function deps(
  child: ScriptedChild,
  clock = createManualClock(),
): { deps: HostSessionDeps; clock: typeof clock } {
  return {
    clock,
    deps: {
      spawn: () => child,
      command: { cmd: ["_host", "--stdio"] },
      clock,
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    },
  };
}

/**
 * Deterministically wait until a predicate holds, draining real macrotasks. Used
 * to know a clock-driven deadline timer is actually armed before advancing the
 * ManualClock — the scripted child replies under real microtasks, so the number
 * of ticks before a timer is armed is not stable (review Findings #11/#15). A
 * fixed `await Promise.resolve()` / `setTimeout(5)` races the arming and hangs.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

describe("createHostSession lifecycle", () => {
  test("spawns, negotiates, mounts, and reaches ready with the first frame", async () => {
    const child = respondingChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const outcome = await session.start();
    expect(outcome).not.toBeInstanceOf(ProtocolError);
    expect(outcome).not.toBeInstanceOf(SupervisorError);
    if (outcome instanceof Error) throw outcome;
    expect(session.phase).toBe("ready");
    expect(outcome.ready.kind).toBe("ready");
    expect(outcome.firstFrame?.frameSeq).toBe("1"); // the frame that arrives AFTER ready
    expect(outcome.negotiatedLimits).toEqual(PROTOCOL_HARD_LIMITS);

    const stop = await session.stop();
    expect(stop.phase).toBe("stopped");
    expect(stop.forced).toBe(false);
    expect(stop.exitCode).toBe(0);
    expect(session.phase).toBe("stopped");
  });

  test("times out to HANDSHAKE_TIMEOUT when host.hello never arrives", async () => {
    const child = respondingChild({ skipHello: true });
    const clock = createManualClock();
    const { deps: sessionDeps } = deps(child, clock);
    const session = createHostSession(spec, sessionDeps);
    const startPromise = session.start();
    // Block until start() is parked in "negotiating" with the handshake timer armed.
    await waitUntil(
      () => session.phase === "negotiating" && clock.pending() >= 1,
      "handshake timer armed",
    );
    clock.advance(HANDSHAKE_TIMEOUT_MS);
    const outcome = await startPromise;
    expect(outcome).toBeInstanceOf(SupervisorError);
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("HANDSHAKE_TIMEOUT");
    expect(session.phase).toBe("failed");
    expect(child.signalCode).toBe("SIGTERM"); // killed + reaped on the failure path
  });

  test("times out to MOUNT_TIMEOUT when ready never arrives", async () => {
    const child = respondingChild({ skipReady: true });
    const clock = createManualClock();
    const { deps: sessionDeps } = deps(child, clock);
    const session = createHostSession(spec, sessionDeps);
    const startPromise = session.start();
    // Handshake completes under real microtasks; block until "mounting" + the 10s timer is armed.
    await waitUntil(
      () => session.phase === "mounting" && clock.pending() >= 1,
      "mount timer armed",
    );
    clock.advance(10_000);
    const outcome = await startPromise;
    expect(outcome).toBeInstanceOf(SupervisorError);
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("MOUNT_TIMEOUT");
    expect(session.phase).toBe("failed");
  });

  test("force-kills and still reaches stopped when shutdown-ack never arrives", async () => {
    const child = respondingChild(); // reaches ready normally...
    const clock = createManualClock();
    const { deps: sessionDeps } = deps(child, clock);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    child.onWrite = () => {}; // ...then stops acking shutdown
    const stopPromise = session.stop();
    // Block until the 1s shutdown-ack timer is armed, then trip it. The forced kill
    // resolves `exited` under a microtask, so the 1s reap timer never needs advancing.
    await waitUntil(() => clock.pending() >= 3, "shutdown-ack timer armed");
    clock.advance(1_000);
    const stop = await stopPromise;
    expect(stop.phase).toBe("stopped");
    expect(stop.forced).toBe(true);
    expect(stop.signalCode).toBe("SIGTERM");
    expect(session.phase).toBe("stopped");
  });

  test("rejects a shutdown-ack whose identity echo is wrong and forces the stop", async () => {
    // The child returns a shutdown-ack with the correct responseTo but a WRONG
    // nonce. §5.2/§10.1: every decoded inbound envelope must echo the incarnation's
    // sessionId AND nonce — a mismatch is fatal. The supervisor must NOT accept the
    // forged ack as a graceful shutdown of THIS incarnation; it must force.
    const child = respondingChild({ badAckIdentity: true });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const stop = await session.stop();
    expect(stop.phase).toBe("stopped");
    expect(stop.forced).toBe(true); // forged-identity ack was rejected, not accepted
    expect(stop.reason).toContain("MALFORMED_PROTOCOL");
    expect(session.phase).toBe("stopped");
  });
});

// --- 2D-2: post-ready pump + stop-via-request-table ---

describe("createHostSession post-ready pump (2D-2)", () => {
  test("the firstFrame reaches the broker and post-ready frames stream through it", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration) as ScriptedChild & {
      emitFrame(seq: string): void;
    };
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const iterator = session.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.frameSeq).toBe("1"); // the captured firstFrame published at pump start

    child.emitFrame("2");
    const second = await iterator.next();
    expect(second.value?.frameSeq).toBe("2");

    await session.stop();
  });

  test("a correlated ping resolves through the request table", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const pong = await session.ping();
    expect(pong).not.toBeInstanceOf(SupervisorError);
    if (pong instanceof Error) throw pong;
    expect(pong.kind).toBe("pong");
    await session.stop();
  });

  test("query correlates a geometry request through the request table and decodes the typed ok reply (blocker B1)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const frameIdentity = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(frameIdentity, { kind: "hit", x: 12, y: 34 });
    expect(result).not.toBeInstanceOf(SupervisorError);
    expect(result).not.toBeInstanceOf(ProtocolError);
    if (result instanceof Error) throw result;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.frameIdentity).toEqual(frameIdentity);
    expect(result.result.echoedKind).toBe("query-hit");
    // §7/blocker B1 adversarial review item 1: the request BODY (not just the reply
    // correlation) must reach the wire intact. `queryFieldsOf` is what puts x/y onto the
    // envelope; the fake host (preview-test-host.ts) echoes them straight back, so a
    // `queryFieldsOf` that drops x/y (e.g. `return {}`) surfaces here as `undefined`.
    expect(result.result.x).toBe(12);
    expect(result.result.y).toBe(34);
    await session.stop();
  });

  test("query maps each GeometryQuery kind to its own wire kind (query-rect/describe/layout)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const frameIdentity = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };

    const rect = await session.query(frameIdentity, { kind: "rect", elementId: "panel-rect" });
    if (rect instanceof Error) throw rect;
    if (!rect.ok) throw new Error("expected ok:true");
    expect(rect.result.echoedKind).toBe("query-rect");
    // §7/blocker B1 adversarial review item 1: elementId must reach the wire, not just
    // the reply's correlation id — a `queryFieldsOf` that drops it surfaces as `undefined`.
    expect(rect.result.elementId).toBe("panel-rect");

    const describe = await session.query(frameIdentity, {
      kind: "describe",
      elementId: "panel-describe",
    });
    if (describe instanceof Error) throw describe;
    if (!describe.ok) throw new Error("expected ok:true");
    expect(describe.result.echoedKind).toBe("query-describe");
    expect(describe.result.elementId).toBe("panel-describe");

    const layout = await session.query(frameIdentity, { kind: "layout" });
    if (layout instanceof Error) throw layout;
    if (!layout.ok) throw new Error("expected ok:true");
    expect(layout.result.echoedKind).toBe("query-layout");
    await session.stop();
  });

  test("a child's STALE_FRAME refusal is decoded as a typed result, not a thrown/fatal error (§7.1)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: () => ({ ok: false, code: "STALE_FRAME", reason: "not the current frame" }),
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const frameIdentity = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "999",
    };
    const result = await session.query(frameIdentity, { kind: "hit", x: 0, y: 0 });
    if (result instanceof Error) throw result;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.code).toBe("STALE_FRAME");
    expect(session.phase).toBe("ready"); // a typed refusal is not a protocol violation
    await session.stop();
  });

  test("a heartbeat feeds the watchdog; 5 s of silence tears down to failed with HEARTBEAT_TIMEOUT", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration) as ScriptedChild & {
      emitHeartbeat(): void;
    };
    const clock = createManualClock();
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const base = deps(child, clock).deps;
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) });
    const started = await session.start();
    if (started instanceof Error) throw started;
    // Arm the 5 s heartbeat deadline (the pump called watchdog.start() at ready).
    await waitUntil(() => clock.pending() >= 1, "heartbeat timer armed");
    clock.advance(5_000);
    // `phase` flips to "failed" SYNCHRONOUSLY inside failFromReady, but onFatal is
    // invoked at the END of the async finalizeFatalTeardown — so wait on `fatals`,
    // NOT on `phase`, or the assertion runs before onFatal fires (deterministic red).
    await waitUntil(() => fatals.length === 1, "onFatal fired after teardown");
    expect(session.phase).toBe("failed");
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("HEARTBEAT_TIMEOUT");
  });

  test("a post-ready fatal with no onFatal sink still logs via console.warn, not silently (errore rule 21)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration) as ScriptedChild & {
      emitHeartbeat(): void;
    };
    const clock = createManualClock();
    const base = deps(child, clock).deps; // deliberately NO onFatal
    const session = createHostSession(spec, base);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      await waitUntil(() => clock.pending() >= 1, "heartbeat timer armed");
      clock.advance(5_000);
      await waitUntil(() => session.phase === "failed", "post-ready fatal reached failed");
      // give finalizeFatalTeardown's async teardown a chance to complete and log
      await waitUntil(
        () =>
          warnCalls.some(
            (call) => typeof call[0] === "string" && call[0].includes("post-ready fatal outcome"),
          ),
        "console.warn fired with the dropped fatal error",
      );
      const matching = warnCalls.find(
        (call) => typeof call[0] === "string" && call[0].includes("post-ready fatal outcome"),
      );
      expect(matching).toBeDefined();
      expect(
        matching?.some((arg) => typeof arg === "string" && arg.includes("HEARTBEAT_TIMEOUT")),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("stop() correlates shutdown-ack through the request table (graceful path still works)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const stop = await session.stop();
    expect(stop.phase).toBe("stopped");
    expect(stop.forced).toBe(false);
    expect(stop.exitCode).toBe(0);
  });

  test("a post-ready frame with a wrong nonce is a fatal MALFORMED_PROTOCOL, not a silent drop (§10.1/§5.3/§12)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const clock = createManualClock();
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const base = deps(child, clock).deps;
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) });
    const started = await session.start();
    if (started instanceof Error) throw started;
    // The live child (correct identity) emits a frame whose nonce does NOT match this
    // incarnation. With ONE decoder there is no cross-nonce noise — it is a real §10.1
    // violation the pump must fatal, not drop. (A backwards frameSeq is symmetric: the
    // broker returns "stale" on an identity-valid frame → onPumpFatal MALFORMED_PROTOCOL.)
    const forged: FrameEnvelope = {
      protocolVersion: 1,
      kind: "frame",
      sessionId: session.identity.sessionId,
      nonce: "f".repeat(32),
      sourceHash: spec.sourceHash,
      frameSeq: "2",
      width: 80,
      height: 24,
      rows: Array.from({ length: 24 }, () => []),
    };
    const framed = frameFrame(forged);
    if (framed instanceof ProtocolError) throw framed;
    child.emit(framed);
    await waitUntil(() => fatals.length === 1, "pump fataled on the wrong-nonce frame");
    expect(session.phase).toBe("failed");
    expect(fatals[0] instanceof ProtocolError && fatals[0].code).toBe("MALFORMED_PROTOCOL");
  });
});

// --- adversarial review of slice 6D, item 4: parseGeometryReply's malformed-reply
// branches had zero coverage, and it never checked that the reply's echoed
// frameIdentity EQUALS the one the caller requested — a child answering against a
// DIFFERENT frame would pass through as ok:true. Every scenario here drives through
// the public `session.query()` API using `livePreviewChild`'s `queryReply` seam
// (never re-invents a double), so the query correlates through the REAL request
// table and only the reply BODY shape is scripted.
describe("createHostSession query reply decoding — malformed replies (adversarial review item 4)", () => {
  test("a reply that echoes a DIFFERENT frameIdentity than requested is a fatal MALFORMED_PROTOCOL, not silently accepted as ok:true", async () => {
    const wrongIdentity = {
      sessionId: "some-other-session",
      nonce: "b".repeat(32),
      sourceHash: "b".repeat(64),
      frameSeq: "999",
    };
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: () => ({
        ok: true,
        frameIdentity: wrongIdentity,
        result: { echoedKind: "query-hit" },
      }),
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const requested = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(requested, { kind: "hit", x: 1, y: 1 });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) {
      expect(result.code).toBe("MALFORMED_PROTOCOL");
      expect(result.reason).toContain("frameIdentity");
    }
    expect(session.phase).toBe("ready"); // a decode-level rejection, not a pump-fatal teardown
    await session.stop();
  });

  test("a reply with a missing frameIdentity is a MALFORMED_PROTOCOL", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: () => ({ ok: true, result: {} }),
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const requested = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(requested, { kind: "layout" });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) {
      expect(result.code).toBe("MALFORMED_PROTOCOL");
      expect(result.reason).toContain("missing frameIdentity");
    }
    await session.stop();
  });

  test("a reply whose frameIdentity fields are not all strings is a MALFORMED_PROTOCOL", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: (_kind, requestBody) => ({
        ok: true,
        frameIdentity: { ...(requestBody.frameIdentity as object), frameSeq: 1 }, // a number, not a string
        result: {},
      }),
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const requested = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(requested, { kind: "layout" });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) {
      expect(result.code).toBe("MALFORMED_PROTOCOL");
      expect(result.reason).toContain("must be strings");
    }
    await session.stop();
  });

  test("a reply with a missing/non-object result is a MALFORMED_PROTOCOL", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: (_kind, requestBody) => ({ ok: true, frameIdentity: requestBody.frameIdentity }), // no `result` key at all
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const requested = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(requested, { kind: "layout" });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) {
      expect(result.code).toBe("MALFORMED_PROTOCOL");
      expect(result.reason).toContain("missing result");
    }
    await session.stop();
  });

  test("a refusal (ok:false) carrying any code OTHER than STALE_FRAME is a MALFORMED_PROTOCOL, not silently accepted", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration, {
      queryReply: () => ({ ok: false, code: "SOME_UNKNOWN_CODE", reason: "not a real refusal" }),
    });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const requested = {
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      sourceHash: spec.sourceHash,
      frameSeq: "1",
    };
    const result = await session.query(requested, { kind: "layout" });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) {
      expect(result.code).toBe("MALFORMED_PROTOCOL");
      expect(result.reason).toContain("unexpected");
    }
    await session.stop();
  });
});

// --- 2D-2 adversarial review: request-table capacity guard (findings 3 & 4) ---

/**
 * A test seam: delegate register/resolve/supersede/clear to the REAL request
 * table (so correlation still works end-to-end) but make `size()` always
 * report full. This lets a test exercise the pre-send capacity guards
 * (sendRequest, stop()) without actually filling 64 real slots. The handshake
 * and mount reach `ready` via nextInbound/awaitReady, not the request table,
 * so a "full" table still lets start() reach ready.
 */
function fullTableDeps(base: HostSessionDeps): HostSessionDeps {
  return {
    ...base,
    createRequestTable: (clock, opts) => {
      const real = createRequestTable(clock, opts);
      return { ...real, size: () => REQUEST_TABLE_CAPACITY };
    },
  };
}

/** Like {@link fullTableDeps}, but `full` can be toggled mid-test instead of staying full for the session's whole life. */
function toggleableFullTableDeps(base: HostSessionDeps): {
  deps: HostSessionDeps;
  setFull: (full: boolean) => void;
} {
  let full = false;
  const deps: HostSessionDeps = {
    ...base,
    createRequestTable: (clock, opts) => {
      const real = createRequestTable(clock, opts);
      return { ...real, size: () => (full ? REQUEST_TABLE_CAPACITY : real.size()) };
    },
  };
  return { deps, setFull: (value) => (full = value) };
}

/** Decode a single written frame's control envelope `kind`, or null if not decodable. */
async function decodeWrittenKind(bytes: Uint8Array): Promise<string | null> {
  const carrier = createScriptedChild();
  carrier.emit(bytes);
  carrier.endStdout();
  for await (const message of readInbound(carrier)) {
    if (message instanceof Error) return null;
    if (message.messageClass !== "control") return null;
    const parsed = JSON.parse(new TextDecoder().decode(message.payload)) as { kind: string };
    return parsed.kind;
  }
  return null;
}

/** Decode a single written control envelope in full (kind + body + requestId), or null. */
async function decodeWrittenEnvelope(bytes: Uint8Array): Promise<ControlEnvelope | null> {
  const carrier = createScriptedChild();
  carrier.emit(bytes);
  carrier.endStdout();
  for await (const message of readInbound(carrier)) {
    if (message instanceof Error) return null;
    if (message.messageClass !== "control") return null;
    return JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope;
  }
  return null;
}

describe("createHostSession request-table capacity guard (2D-2 adversarial review)", () => {
  test("sendRequest's pre-send guard rejects TOO_MANY_REQUESTS before writing any envelope when the table reports full", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, fullTableDeps(sessionDeps));
    const started = await session.start();
    if (started instanceof Error) throw started;
    const writtenAtReady = child.written.length;
    const result = await session.ping();
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("TOO_MANY_REQUESTS");
    expect(child.written.length).toBe(writtenAtReady); // no envelope written for the rejected ping
    await session.stop();
  });

  // Whole-branch review (design-tree phase 3 Task 9): the pump's `pendingMount` slot is only
  // ever cleared by a REPLY correlating to it. A `mount()` refused before it ever reaches the
  // wire (this guard) has no reply coming, so without a defensive clear the slot would stay
  // stuck forever, and every LATER mount() would be wrongly refused as "already in flight".
  test("a mount() refused by the pre-send TOO_MANY_REQUESTS guard does not leave a later mount() stuck as 'already in flight'", async () => {
    const child = switchableChild();
    const { deps: base } = deps(child);
    const { deps: sessionDeps, setFull } = toggleableFullTableDeps(base);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    setFull(true);
    const refused = await session.mount(pageB);
    expect(refused).toBeInstanceOf(SupervisorError);
    if (refused instanceof SupervisorError) expect(refused.code).toBe("TOO_MANY_REQUESTS");

    setFull(false);
    const result = await session.mount(pageB);
    // Must be the real outcome of a real mount, never the stuck-slot's "already in flight".
    expect(result).not.toBeInstanceOf(SupervisorError);

    await session.stop();
  });

  test("stop() forces teardown without writing a shutdown envelope when the request table reports full", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(spec, fullTableDeps(sessionDeps));
    const started = await session.start();
    if (started instanceof Error) throw started;
    const writtenAtReady = child.written.length;

    const stop = await session.stop();
    expect(stop.phase).toBe("stopped");
    expect(stop.forced).toBe(true);
    expect(stop.reason).toContain("request table full");

    // No shutdown envelope was written after ready — decode every write since
    // ready and assert none of them is a "shutdown" control envelope.
    const writesSinceReady = child.written.slice(writtenAtReady);
    const kinds = await Promise.all(writesSinceReady.map(decodeWrittenKind));
    expect(kinds).not.toContain("shutdown");
  });
});

describe("createHostSession flood detection (2D-3, §8)", () => {
  test("a post-ready frame that trips the flood monitor tears down to failed with PROTOCOL_FLOOD", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration) as ScriptedChild & {
      emitFrame(seq: string): void;
    };
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const floodMonitor: FloodMonitor = {
      noteFrame: () => new SupervisorError({ code: "PROTOCOL_FLOOD", reason: "test frame flood" }),
      noteStderr: () => null,
    };
    const base = deps(child).deps;
    const session = createHostSession(spec, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createFloodMonitor: () => floodMonitor,
    });
    const started = await session.start();
    if (started instanceof Error) throw started;
    child.emitFrame("2"); // the first post-ready frame the pump meters → flood
    await waitUntil(() => fatals.length === 1, "onFatal fired on frame flood");
    expect(session.phase).toBe("failed");
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("PROTOCOL_FLOOD");
  });

  test("an stderr burst that trips the flood monitor tears down to failed with STDERR_FLOOD", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const floodMonitor: FloodMonitor = {
      noteFrame: () => null,
      noteStderr: () => new SupervisorError({ code: "STDERR_FLOOD", reason: "test stderr flood" }),
    };
    const base = deps(child).deps;
    const session = createHostSession(spec, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createFloodMonitor: () => floodMonitor,
    });
    const started = await session.start();
    if (started instanceof Error) throw started;
    child.emitStderr(new Uint8Array([1, 2, 3])); // the drain meters this chunk → flood
    await waitUntil(() => fatals.length === 1, "onFatal fired on stderr flood");
    expect(session.phase).toBe("failed");
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("STDERR_FLOOD");
  });
});

// --- control-queue.ts / control-mailbox.ts wired into the live path ---

/**
 * A request table with an inflated real capacity (10,000) AND a `size()` that always
 * reports 0, so a queue-capacity test isn't gated by the (much smaller) 64-slot request
 * table — every enqueued request also holds a table slot until answered, so testing the
 * queue's OWN 256 boundary needs the table's pre-send guards (`sendRequest`/`stop()`, both
 * of which read `.size()`) out of the way. Mirrors `fullTableDeps` above, in the opposite
 * direction: `register`/`resolve`/`supersede`/`clear` still operate on the real 10,000-slot
 * table, so correlation stays real; only the exposed `.size()` lies.
 */
function unboundedTableDeps(base: HostSessionDeps): HostSessionDeps {
  return {
    ...base,
    createRequestTable: (clock, opts) => {
      const real = createRequestTable(clock, { ...opts, capacity: 10_000 });
      return { ...real, size: () => 0 };
    },
  };
}

describe("createHostSession outbound control-queue wiring (§8, HOST_BACKPRESSURED/preview.writable)", () => {
  test("filling the outbound queue to 256 rejects the next discrete command with HOST_BACKPRESSURED and fires onBackpressureChange", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const base = deps(child).deps;
    const backpressureEvents: ("backpressured" | "writable")[] = [];
    const session = createHostSession(
      spec,
      unboundedTableDeps({ ...base, onBackpressureChange: (s) => backpressureEvents.push(s) }),
    );
    const started = await session.start();
    if (started instanceof Error) throw started;

    // Hold writes so the drain's FIRST dequeue never completes: item 1 leaves the queue
    // (pumpOutbound dequeues eagerly) but is stuck awaiting its write, so items 2..257
    // accumulate behind it without being dequeued — deterministic, no microtask-timing
    // guesswork. entries.length reaches 256 exactly at the 257th enqueue (1 dequeued + 256
    // still queued), which is also where the queue's own `backpressured` flag flips.
    child.holdWrites();
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 257; i += 1) pending.push(session.resize({ w: 10, h: 10 }));
    expect(backpressureEvents).toEqual(["backpressured"]);

    const overflow = await session.resize({ w: 11, h: 11 });
    expect(overflow).toBeInstanceOf(SupervisorError);
    if (overflow instanceof SupervisorError) expect(overflow.code).toBe("HOST_BACKPRESSURED");

    child.releaseWrites();
    await Promise.all(pending); // let the drain catch up so stop() below is clean
    await waitUntil(
      () => backpressureEvents.includes("writable"),
      "onBackpressureChange fired writable once drained",
    );
    await session.stop();
  });

  test("a rejected-by-backpressure request never reaches the wire — total writes equal exactly the 257 accepted resizes", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration);
    const base = deps(child).deps;
    const session = createHostSession(spec, unboundedTableDeps(base));
    const started = await session.start();
    if (started instanceof Error) throw started;
    const writtenAtReady = child.written.length;

    child.holdWrites();
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 257; i += 1) pending.push(session.resize({ w: 10, h: 10 }));
    const overflow = await session.resize({ w: 11, h: 11 });
    expect(overflow).toBeInstanceOf(SupervisorError);

    child.releaseWrites();
    await Promise.all(pending); // let all 257 legitimate resizes actually drain to the wire
    // Exactly 257 new writes — the 258th (backpressured) request contributed none.
    expect(child.written.length - writtenAtReady).toBe(257);
    await session.stop();
  });
});

describe("createHostSession inbound control-mailbox wiring (§8, CONTROL_BACKPRESSURE)", () => {
  test("an inbound burst past the 256-entry mailbox is CONTROL_BACKPRESSURE — kills the incarnation", async () => {
    const clock = createManualClock();
    const child = livePreviewChild(spec, runtimeDeclaration);
    const base = deps(child, clock).deps;
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const controlEvents: string[] = [];
    const session = createHostSession(spec, {
      ...base,
      onFatal: (e) => fatals.push(e),
      onControlEvent: (e) => controlEvents.push(e.kind),
    });
    const started = await session.start();
    if (started instanceof Error) throw started;

    // 257 unsolicited (non-response, non-heartbeat, non-error) envelopes, emitted in one
    // synchronous burst. The clock is never advanced, so the clock-scheduled mailbox drain
    // never runs — they must pile up in the bounded mailbox instead of draining instantly.
    for (let i = 0; i < 257; i += 1) {
      const envelope: ControlEnvelope = {
        protocolVersion: 1,
        kind: "runtime-warning",
        sessionId: session.identity.sessionId,
        nonce: session.identity.nonce,
        messageId: String(1000 + i),
        body: {},
      };
      const framed = frameControl(envelope);
      if (framed instanceof ProtocolError) throw framed;
      child.emit(framed);
    }
    await waitUntil(() => fatals.length === 1, "CONTROL_BACKPRESSURE fatal fired");
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("CONTROL_BACKPRESSURE");
    expect(session.phase).toBe("failed");
  });

  test("an ordinary unsolicited control envelope still reaches onControlEvent once drained (no regression for the common case)", async () => {
    const clock = createManualClock();
    const child = livePreviewChild(spec, runtimeDeclaration);
    const base = deps(child, clock).deps;
    const controlEvents: string[] = [];
    const session = createHostSession(spec, {
      ...base,
      onControlEvent: (e) => controlEvents.push(e.kind),
    });
    const started = await session.start();
    if (started instanceof Error) throw started;

    const envelope: ControlEnvelope = {
      protocolVersion: 1,
      kind: "runtime-warning",
      sessionId: session.identity.sessionId,
      nonce: session.identity.nonce,
      messageId: "2000",
      body: {},
    };
    const framed = frameControl(envelope);
    if (framed instanceof ProtocolError) throw framed;
    child.emit(framed);
    // Give the pump's async decode a real chance to run WITHOUT advancing the clock —
    // the envelope must sit offered-but-undelivered until the scheduled drain fires.
    for (let i = 0; i < 50 && controlEvents.length === 0; i += 1) await Promise.resolve();
    expect(controlEvents).toHaveLength(0);
    clock.advance(0); // let the scheduled mailbox drain run
    await waitUntil(
      () => controlEvents.includes("runtime-warning"),
      "onControlEvent fired via the mailbox drain",
    );
    await session.stop();
  });
});

// --- Task 3: HostSession.mount() — a correlated mount in the ready phase (design §9.2) ---

interface CapturedIdentity {
  sessionId: string;
  nonce: string;
}

/**
 * A scripted child for the mount() suite. Answers the handshake and the FIRST mount (the one
 * start() sends) automatically, exactly like `respondingChild` above. When `autoReplyMounts` is
 * true (the default) every LATER mount also gets an immediate correlated `ready` — enough for
 * `mount()` to resolve, since committing the new identity only needs the `ready` envelope, not a
 * frame (session.ts's pending-mount pump hook). When false, every mount past the first is left
 * for the test to drive by hand via `emitFrame`/`emitReadyFor` below — used by tests that need
 * to control exactly when a frame arrives relative to the switch's `ready`.
 */
function switchableChild(options?: {
  autoReplyMounts?: boolean;
}): ScriptedChild & { identity: () => CapturedIdentity | null; mountRequestIds: string[] } {
  const autoReplyMounts = options?.autoReplyMounts ?? true;
  const child = createScriptedChild();
  let id: CapturedIdentity | null = null;
  let replyMessageId = 500n;
  const nextReplyMessageId = () => {
    const value = replyMessageId.toString();
    replyMessageId += 1n;
    return value;
  };
  const mountRequestIds: string[] = [];
  child.onWrite = (bytes) => void decodeWrite(bytes);
  async function decodeWrite(bytes: Uint8Array) {
    const carrier = createScriptedChild();
    carrier.emit(bytes);
    carrier.endStdout();
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return;
      if (message.messageClass !== "control") return;
      const parsed = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope;
      if (parsed.kind === "client.hello" && id === null) {
        id = { sessionId: parsed.sessionId, nonce: parsed.nonce };
        const hostHello: HostHelloV1 = {
          framingVersion: 1,
          kind: "host.hello",
          sessionId: id.sessionId,
          nonce: id.nonce,
          selectedFramingVersion: 1,
          selectedProtocolVersion: 1,
          runtimeDeclaration,
          limits: PROTOCOL_HARD_LIMITS,
        };
        const framed = frameHostHello(hostHello);
        if (!(framed instanceof ProtocolError)) child.emit(framed);
        return;
      }
      if (id === null) return;
      if (parsed.kind === "shutdown") {
        const ack: ControlEnvelope = {
          protocolVersion: 1,
          kind: "shutdown-ack",
          sessionId: id.sessionId,
          nonce: id.nonce,
          messageId: nextReplyMessageId(),
          responseTo: parsed.requestId,
          body: { ok: true },
        };
        const framed = frameControl(ack);
        if (!(framed instanceof ProtocolError)) child.emit(framed);
        child.simulateExit({ code: 0 });
        return;
      }
      if (parsed.kind !== "mount") return;
      mountRequestIds.push(parsed.requestId ?? "");
      const isFirst = mountRequestIds.length === 1;
      if (!isFirst && !autoReplyMounts) return; // left for the test to drive by hand
      const ready: ControlEnvelope = {
        protocolVersion: 1,
        kind: "ready",
        sessionId: id.sessionId,
        nonce: id.nonce,
        messageId: nextReplyMessageId(),
        responseTo: parsed.requestId,
        body: { size: { w: 80, h: 24 }, interactionMode: "static" },
      };
      const readyFramed = frameControl(ready);
      if (!(readyFramed instanceof ProtocolError)) child.emit(readyFramed);
      if (isFirst) {
        // awaitReady needs BOTH ready and a first frame before start() can reach "ready".
        const frame: FrameEnvelope = {
          protocolVersion: 1,
          kind: "frame",
          sessionId: id.sessionId,
          nonce: id.nonce,
          sourceHash: spec.sourceHash,
          frameSeq: "1",
          width: 80,
          height: 24,
          rows: Array.from({ length: 24 }, () => []),
        };
        const frameFramed = frameFrame(frame);
        if (!(frameFramed instanceof ProtocolError)) child.emit(frameFramed);
      }
    }
  }
  return Object.assign(child, { identity: () => id, mountRequestIds });
}

/** Hand-emit a frame with a specific sourceHash/frameSeq, for tests that control ordering. */
function emitFrame(
  child: ScriptedChild,
  id: CapturedIdentity,
  sourceHash: string,
  frameSeq: string,
): void {
  const frame: FrameEnvelope = {
    protocolVersion: 1,
    kind: "frame",
    sessionId: id.sessionId,
    nonce: id.nonce,
    sourceHash,
    frameSeq,
    width: 80,
    height: 24,
    rows: Array.from({ length: 24 }, () => []),
  };
  const framed = frameFrame(frame);
  if (framed instanceof ProtocolError) throw framed;
  child.emit(framed);
}

let emittedReadyMessageId = 9_000n;
/** Hand-emit a correlated `ready` for a given requestId, for tests that control ordering. */
function emitReadyFor(child: ScriptedChild, id: CapturedIdentity, requestId: string): void {
  const messageId = emittedReadyMessageId.toString();
  emittedReadyMessageId += 1n;
  const ready: ControlEnvelope = {
    protocolVersion: 1,
    kind: "ready",
    sessionId: id.sessionId,
    nonce: id.nonce,
    messageId,
    responseTo: requestId,
    body: { size: { w: 80, h: 24 }, interactionMode: "static" },
  };
  const framed = frameControl(ready);
  if (framed instanceof ProtocolError) throw framed;
  child.emit(framed);
}

/** A typed `kind: "error"` reply correlated to `requestId` — the child's refusal shape. */
function emitErrorFor(
  child: ScriptedChild,
  id: CapturedIdentity,
  requestId: string,
  code: string,
): void {
  const messageId = emittedReadyMessageId.toString();
  emittedReadyMessageId += 1n;
  const error: ControlEnvelope = {
    protocolVersion: 1,
    kind: "error",
    sessionId: id.sessionId,
    nonce: id.nonce,
    messageId,
    responseTo: requestId,
    body: { code, reason: "mount refused" },
  };
  const framed = frameControl(error);
  if (framed instanceof ProtocolError) throw framed;
  child.emit(framed);
}

/**
 * One recorded call into a spying `FrameBroker` (below) — order-of-calls evidence recording
 * that `broker.expect(newHash)` lands, in call order, between the old page's last accepted
 * publish and the new page's first publish. Kept as regression-pinning/documentation of the
 * INTENDED call order, not as proof of synchronicity: verified empirically (see the header
 * comment on the test using this below) that in Bun's actual scheduling this ordering holds
 * even against a deliberately injected `.then()`-deferred variant of the reseed, so it cannot,
 * on its own, discriminate the two implementations. The primary evidence that the reseed is
 * synchronous/inline is the structural code trace of `session.ts`'s pump hook, not this test.
 */
type BrokerCall =
  | { readonly kind: "expect"; readonly sourceHash: string }
  | {
      readonly kind: "publish";
      readonly sourceHash: string;
      readonly frameSeq: string;
      readonly result: "accepted" | "stale";
    };

/** Wraps the REAL frame broker so every `publish`/`expect` call is recorded, in call order. */
function createSpyingBroker(
  guard: { sessionId: string; nonce: string; sourceHash: string },
  calls: BrokerCall[],
): FrameBroker {
  const real = createFrameBroker(guard);
  return {
    ...real,
    publish: (frame) => {
      const result = real.publish(frame);
      calls.push({
        kind: "publish",
        sourceHash: frame.sourceHash,
        frameSeq: frame.frameSeq,
        result,
      });
      return result;
    },
    expect: (sourceHash) => {
      calls.push({ kind: "expect", sourceHash });
      real.expect(sourceHash);
    },
  };
}

describe("createHostSession.mount() — switch pages inside a live incarnation (design §9.2)", () => {
  test("mount() from ready sends a correlated mount and resolves on its ready", async () => {
    const child = switchableChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const result = await session.mount(pageB);
    expect(result).not.toBeInstanceOf(Error);

    const written = await Promise.all(child.written.map(decodeWrittenEnvelope));
    const mounts = written.filter((e): e is ControlEnvelope => e !== null && e.kind === "mount");
    expect(mounts.length).toBe(2); // start()'s mount + this one
    expect(mounts.at(-1)?.body.entryRelPath).toBe("pages/b.tsx");
    expect((result as ControlEnvelope).responseTo).toBe(mounts.at(-1)?.requestId);

    await session.stop();
  });

  // Review finding 4: `deterministic` must be DERIVED from `spec.mode`, not hardcoded — a
  // hardcoded `false` would pass every OTHER test in this suite (all of which use `preview`
  // mode, where the derived value also happens to be `false`) while silently being wrong for
  // `smoke`/`export`. Exercising `mount()` from a `smoke`-mode session is what actually
  // discriminates a derived value from a hardcoded one.
  test("mount() derives deterministic from spec.mode instead of hardcoding it", async () => {
    const smokeSpec: HostSessionSpec = { ...specWithB, mode: "smoke" };
    const child = switchableChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(smokeSpec, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const result = await session.mount(pageB);
    expect(result).not.toBeInstanceOf(Error);

    const written = await Promise.all(child.written.map(decodeWrittenEnvelope));
    const mounts = written.filter((e): e is ControlEnvelope => e !== null && e.kind === "mount");
    expect(mounts.at(-1)?.body.deterministic).toBe(true);

    await session.stop();
  });

  // Review finding 3: `pendingMount` is a single slot, not a queue. A second `mount()` while
  // one is still outstanding must be refused outright — silently overwriting the slot would
  // orphan the first mount's `ready` (the pump hook would no longer recognise it) and could
  // fatal the incarnation over a frame the child was correct to send.
  test("a second mount() call while one is already in flight is refused, not silently overwritten", async () => {
    const child = switchableChild({ autoReplyMounts: false });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const firstMountPromise = session.mount(pageB);
    await waitUntil(() => child.mountRequestIds.length === 2, "first repeated mount written");

    const secondResult = await session.mount(pageB);
    expect(secondResult).toBeInstanceOf(SupervisorError);
    if (secondResult instanceof SupervisorError) expect(secondResult.code).toBe("TRANSPORT_ERROR");
    expect(child.mountRequestIds.length).toBe(2); // the refused second call wrote nothing

    // Let the first (still legitimate) mount settle so stop() below does not hang —
    // `autoReplyMounts: false` leaves it undriven, so drive it by hand.
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");
    emitReadyFor(child, id, child.mountRequestIds[1] as string);
    const firstResult = await firstMountPromise;
    expect(firstResult).not.toBeInstanceOf(Error);

    await session.stop();
  });

  // Whole-branch review (design-tree phase 3 Task 9): the pump's inline `pendingMount` hook
  // only COMMITS a switch on `kind === "ready"`, but the generic `responseTo` routing resolves
  // the request table with the RAW envelope regardless of `kind` — so an uncaught `kind ===
  // "error"` reply used to reach the caller looking exactly like a `ControlEnvelope` success.
  test("a repeated mount() the child refuses with a typed error resolves to that typed error, never a ControlEnvelope success", async () => {
    const child = switchableChild({ autoReplyMounts: false });
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const mountPromise = session.mount(pageB);
    await waitUntil(() => child.mountRequestIds.length === 2, "second mount written");
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");
    emitErrorFor(child, id, child.mountRequestIds[1] as string, "SOURCE_HASH_MISMATCH");

    const result = await mountPromise;
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) expect(result.code).toBe("SOURCE_HASH_MISMATCH");

    await session.stop();
  });

  test("a frame naming the NEW page is accepted only after its ready is observed", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const brokerCalls: BrokerCall[] = [];
    const child = switchableChild({ autoReplyMounts: false });
    const base = deps(child).deps;
    const session = createHostSession(specWithB, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createBroker: (guard) => createSpyingBroker(guard, brokerCalls),
    });
    const started = await session.start();
    if (started instanceof Error) throw started;
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");

    const iterator = session.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.frameSeq).toBe("1");

    const mountPromise = session.mount(pageB);
    await waitUntil(() => child.mountRequestIds.length === 2, "second mount written");
    const secondRequestId = child.mountRequestIds[1] as string;

    // A trailing OLD-page frame that was already in flight when the switch was requested —
    // every frame of the old page was written before the child even processed the mount
    // (read-claim 5), so this must be ACCEPTED, not treated as fatal.
    emitFrame(child, id, spec.sourceHash, "2");
    const second = await iterator.next();
    expect(second.value?.frameSeq).toBe("2");
    expect(second.done).toBe(false);

    // Only once the switch's `ready` is OBSERVED does the guard's expected hash move. Emit the
    // switch's `ready` and the new page's first frame BACK TO BACK — deliberately with NO
    // `await` of `mountPromise` in between, and frame B's bytes are not written until AFTER
    // `ready`'s. Awaiting `mountPromise` first (as an earlier version of this test did) would
    // let ANY implementation's reseed — synchronous-inline (correct) OR deferred via a
    // `.then()` on this exact promise (the bug this test exists to catch) — run to completion
    // before frame B even exists on the wire, which guarantees these assertions pass either
    // way and proves nothing on its own.
    //
    // HONEST LIMITATION (verified empirically, not asserted): this reordering, and even a
    // stronger variant that concatenates `ready` + frame B into ONE emitted chunk (so
    // `readInbound`'s decoder yields both from a single `child.stdout` read), still cannot
    // observably distinguish this synchronous-inline implementation from a deliberately
    // injected `.then()`-on-the-same-promise variant in Bun's actual scheduling — the pump's
    // multi-layer async-generator chain (byte queue -> `readInbound` -> `runPump`'s `for
    // await`) costs MORE microtask hops to deliver frame B than the single hop a `.then()`
    // reaction needs to fire, so the buggy reseed reliably wins the race and frame B is
    // accepted either way, 10/10 runs against both variants. The `brokerCalls` order
    // assertions below are kept as regression-pinning/documentation of the intended call
    // order, not as proof the pump is synchronous-inline — that property's primary evidence
    // is the structural code trace (no `await`/`.then` between decoding `ready` and calling
    // `broker.expect()` in `session.ts`'s pump hook), verified by reading the code directly.
    emitReadyFor(child, id, secondRequestId);
    emitFrame(child, id, PAGE_B_SOURCE_HASH, "3");

    const mountResult = await mountPromise;
    expect(mountResult).not.toBeInstanceOf(Error);

    // A NEW-page frame after the switch's ready — accepted under the re-seeded guard.
    const third = await iterator.next();
    expect(third.value?.frameSeq).toBe("3");
    expect(third.done).toBe(false);

    expect(fatals).toHaveLength(0);
    expect(session.phase).toBe("ready");

    // The discriminating evidence (review finding 1): `await`ing `mountResult` above only
    // proves the re-seed happened by SOME point — it cannot tell a synchronous, inline
    // re-seed apart from one that merely happened to settle before this particular await
    // returned. The RECORDED CALL ORDER can: `expect(B)` must land strictly between the old
    // page's last accepted publish and the new page's first publish, which is true only if
    // the pump re-seeds the guard in the SAME iteration it decodes the switch's `ready`.
    const publishOldIndex = brokerCalls.findIndex(
      (c) => c.kind === "publish" && c.sourceHash === spec.sourceHash && c.frameSeq === "2",
    );
    const expectNewIndex = brokerCalls.findIndex(
      (c) => c.kind === "expect" && c.sourceHash === PAGE_B_SOURCE_HASH,
    );
    const publishNewIndex = brokerCalls.findIndex(
      (c) => c.kind === "publish" && c.sourceHash === PAGE_B_SOURCE_HASH && c.frameSeq === "3",
    );
    expect(publishOldIndex).toBeGreaterThanOrEqual(0);
    expect(expectNewIndex).toBeGreaterThanOrEqual(0);
    expect(publishNewIndex).toBeGreaterThanOrEqual(0);
    expect(publishOldIndex).toBeLessThan(expectNewIndex);
    expect(expectNewIndex).toBeLessThan(publishNewIndex);

    await session.stop();
  });

  test("a frame naming a page this incarnation never mounted is still fatal", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const child = switchableChild();
    const base = deps(child).deps;
    const session = createHostSession(specWithB, { ...base, onFatal: (e) => fatals.push(e) });
    const started = await session.start();
    if (started instanceof Error) throw started;
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");

    // PAGE_C_SOURCE_HASH was never named by any mount this incarnation sent — a protocol
    // violation, not a frame to display, even though its shape is otherwise well-formed.
    emitFrame(child, id, PAGE_C_SOURCE_HASH, "2");
    await waitUntil(() => fatals.length === 1, "pump fataled on the never-mounted hash");
    expect(session.phase).toBe("failed");
    expect(fatals[0] instanceof ProtocolError && fatals[0].code).toBe("MALFORMED_PROTOCOL");
  });

  // Review finding 2: a frame naming a page this incarnation LEGITIMATELY mounted but has
  // since been SUPERSEDED by a later mount is a different failure than a frameSeq regression
  // (`checkFrameIdentity` accepts it via `mountedHashes`, but `broker.publish` rejects it as
  // stale because it no longer names the CURRENTLY expected hash) — the diagnosis must say so
  // honestly instead of blaming a monotonic frameSeq that was never actually out of order.
  test("a frame naming a SUPERSEDED (but legitimately mounted) page is fatal with an honest diagnosis, not a frameSeq accusation", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const child = switchableChild();
    const base = deps(child).deps;
    const session = createHostSession(specWithB, { ...base, onFatal: (e) => fatals.push(e) });
    const started = await session.start();
    if (started instanceof Error) throw started;
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");

    const mountResult = await session.mount(pageB);
    expect(mountResult).not.toBeInstanceOf(Error);

    // Page A (spec.sourceHash) is still in `mountedHashes` (legitimately mounted first), but
    // is no longer the CURRENT page — the broker now expects B. This frame's own seq (2) is
    // perfectly monotonic; it is fatal ONLY because it names a superseded page.
    emitFrame(child, id, spec.sourceHash, "2");
    await waitUntil(() => fatals.length === 1, "pump fataled on the superseded-page frame");
    expect(session.phase).toBe("failed");
    const fatal = fatals[0];
    expect(fatal instanceof ProtocolError && fatal.code).toBe("MALFORMED_PROTOCOL");
    expect(fatal instanceof ProtocolError && fatal.reason).toContain("superseded page");
    expect(fatal instanceof ProtocolError && fatal.reason).not.toContain("frameSeq");
  });

  test("identity reports the currently mounted page and a stable sessionId/nonce", async () => {
    const child = switchableChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;

    const before = { ...session.identity };
    const result = await session.mount(pageB);
    expect(result).not.toBeInstanceOf(Error);

    expect(session.identity.sessionId).toBe(before.sessionId);
    expect(session.identity.nonce).toBe(before.nonce);
    expect(session.identity.mode).toBe(before.mode);
    expect(session.identity.pageSlug).toBe("b");
    expect(session.identity.sourceHash).toBe(PAGE_B_SOURCE_HASH);
    expect(session.identity.kitApiVersion).toBe(1);

    await session.stop();
  });

  test("mounting a page whose kitApiVersion the host does not support is refused, deterministically", async () => {
    const child = switchableChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    const started = await session.start();
    if (started instanceof Error) throw started;
    const writtenAtReady = child.written.length;

    const result = await session.mount({ ...pageB, kitApiVersion: 99 });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) expect(result.code).toBe("KIT_API_MISMATCH");
    expect(child.written.length).toBe(writtenAtReady); // nothing written for the refused mount

    await session.stop();
  });

  test("mount() before ready is refused without writing anything", async () => {
    const child = switchableChild();
    const { deps: sessionDeps } = deps(child);
    const session = createHostSession(specWithB, sessionDeps);
    // deliberately never call session.start() — phase stays "created"

    const result = await session.mount(pageB);
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("TRANSPORT_ERROR");
    expect(child.written.length).toBe(0); // the scripted child received no bytes at all
  });
});

// --- Task 4: the mount and first-frame deadlines, and who gets blamed for a hang (design §9.4) ---

/**
 * A no-op `HeartbeatWatchdog` double, injected via `deps.createWatchdog` for every test below
 * that deliberately advances the clock past `MOUNT_TIMEOUT_MS`/`FIRST_FRAME_TIMEOUT_MS`.
 *
 * The real watchdog's own `HEARTBEAT_TIMEOUT_MS` budget is ALSO 5 s, armed at `startPump()` —
 * the same virtual instant these tests reach `ready`, since none of them advance the clock
 * before mounting. Without a stub, advancing past either deadline below would ALSO cross the
 * heartbeat's coincidentally-identical 5 s budget (armed earlier, so it would fire first and
 * tear the incarnation down for an unrelated reason before the test's own timer ever gets a
 * chance to prove anything). Stubbing the watchdog isolates the mount/first-frame machinery
 * this task adds from that separate, pre-existing mechanism.
 */
function noWatchdog(): HeartbeatWatchdog {
  return {
    start() {},
    feedHeartbeat() {},
    noteRequestTimeout() {},
    stop() {},
  };
}

describe("createHostSession — mount and first-frame deadlines (design §9.4)", () => {
  test("a mount that never produces ready fails the incarnation and names the page", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const child = switchableChild({ autoReplyMounts: false });
    const clock = createManualClock();
    const base = deps(child, clock).deps;
    const session = createHostSession(specWithB, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createWatchdog: noWatchdog,
    });
    const started = await session.start();
    if (started instanceof Error) throw started;

    const mountPromise = session.mount(pageB);
    // The child received the mount and stays silent — never replies at all.
    await waitUntil(() => child.mountRequestIds.length === 2, "second mount written");
    clock.advance(MOUNT_TIMEOUT_MS + 1);

    const mountResult = await mountPromise;
    expect(mountResult).toBeInstanceOf(SupervisorError);
    if (mountResult instanceof SupervisorError) expect(mountResult.code).toBe("MOUNT_TIMEOUT");

    await waitUntil(() => fatals.length === 1, "onFatal fired on the no-ready mount deadline");
    const fatal = fatals[0];
    expect(fatal instanceof SupervisorError && fatal.code).toBe("MOUNT_TIMEOUT");
    expect(fatal instanceof SupervisorError && fatal.message).toContain("b");
    expect(session.phase).toBe("failed");
    expect(child.signalCode).toBe("SIGTERM"); // killed + reaped, same as every other fatal path
  });

  test("a ready with no frame after it fails the incarnation under the first-frame deadline", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const child = switchableChild({ autoReplyMounts: false });
    const clock = createManualClock();
    const base = deps(child, clock).deps;
    const session = createHostSession(specWithB, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createWatchdog: noWatchdog,
    });
    const started = await session.start();
    if (started instanceof Error) throw started;
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");

    const mountPromise = session.mount(pageB);
    await waitUntil(() => child.mountRequestIds.length === 2, "second mount written");
    // The switch's `ready` arrives, but no frame ever follows it.
    emitReadyFor(child, id, child.mountRequestIds[1] as string);

    const mountResult = await mountPromise; // resolves once the correlated ready is routed
    expect(mountResult).not.toBeInstanceOf(Error);

    clock.advance(FIRST_FRAME_TIMEOUT_MS + 1);
    await waitUntil(() => fatals.length === 1, "onFatal fired on the first-frame deadline");
    const fatal = fatals[0];
    expect(fatal instanceof SupervisorError && fatal.code).toBe("MOUNT_TIMEOUT");
    expect(fatal instanceof SupervisorError && fatal.message).toContain("no first frame");
    expect(fatal instanceof SupervisorError && fatal.message).toContain("b");
    expect(session.phase).toBe("failed");
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("the first frame cancels the deadline; a later quiet period does not fail", async () => {
    const fatals: (SupervisorError | ProtocolError)[] = [];
    const child = switchableChild({ autoReplyMounts: false });
    const clock = createManualClock();
    const base = deps(child, clock).deps;
    const session = createHostSession(specWithB, {
      ...base,
      onFatal: (e) => fatals.push(e),
      createWatchdog: noWatchdog,
    });
    const started = await session.start();
    if (started instanceof Error) throw started;
    const id = child.identity();
    if (id === null) throw new Error("client.hello identity was never captured");

    const iterator = session.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.frameSeq).toBe("1");

    const mountPromise = session.mount(pageB);
    await waitUntil(() => child.mountRequestIds.length === 2, "second mount written");
    const secondRequestId = child.mountRequestIds[1] as string;
    emitReadyFor(child, id, secondRequestId);
    expect(clock.pending()).toBe(1); // the first-frame deadline, armed the instant `ready` was seen

    emitFrame(child, id, PAGE_B_SOURCE_HASH, "2");
    const second = await iterator.next();
    expect(second.value?.frameSeq).toBe("2");
    expect(clock.pending()).toBe(0); // the accepted frame cancelled it — nothing left armed

    const mountResult = await mountPromise;
    expect(mountResult).not.toBeInstanceOf(Error);

    // A later quiet period does not resurrect a deadline that was already cancelled.
    clock.advance(FIRST_FRAME_TIMEOUT_MS + 1);
    expect(fatals).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  test("a render throw during the initial mount is unaffected: DESIGN_RENDER_FAILED, and start()'s own deadline is cancelled, not fired", async () => {
    const child = respondingChild({ mountErrorCode: "PAGE_RENDER_FAILED" });
    const clock = createManualClock();
    const { deps: sessionDeps } = deps(child, clock);
    const session = createHostSession(spec, sessionDeps);

    const outcome = await session.start();
    expect(outcome).toBeInstanceOf(SupervisorError);
    if (outcome instanceof SupervisorError) {
      expect(outcome.code).toBe("DESIGN_RENDER_FAILED");
      expect(outcome.message).toContain("PAGE_RENDER_FAILED");
    }
    expect(session.phase).toBe("failed");
    // `nextInbound`'s own per-call timer was cancelled the instant the error envelope arrived
    // (Promise.race + timer.cancel()) — the 10 s mount deadline never got a chance to fire, and
    // the first-frame timer never existed in the first place (the pump that owns it starts only
    // after `start()` reaches "ready", which this render throw never does).
    expect(clock.pending()).toBe(0);
  });
});

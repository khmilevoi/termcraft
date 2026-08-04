import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionSpec } from "../../types";
import type { FloodMonitor, HostSessionDeps } from "../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { livePreviewChild } from "./preview-test-host";
import { REQUEST_TABLE_CAPACITY, createRequestTable } from "./request-table";
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child";
import type { ScriptedChild } from "./scripted-child";
import { createHostSession } from "./session";
import { HANDSHAKE_TIMEOUT_MS } from "./timeouts";
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

/**
 * A responding fake host: decodes each supervisor write and emits the scripted
 * reply, so the supervisor's real drive loop runs end-to-end. Reads the
 * supervisor's minted sessionId/nonce off the client.hello it receives.
 */
function respondingChild(options?: {
  skipReady?: boolean;
  skipHello?: boolean;
  badAckIdentity?: boolean;
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

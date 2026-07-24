import { describe, expect, test } from "bun:test";

import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  JsonValue,
  RuntimeDeclarationBundleV1,
} from "../../protocol";
import type { HostSessionSpec } from "../../types";
import { createManualClock } from "./clock";
import { SupervisorError } from "./errors";
import { runOneShotSession } from "./one-shot";
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child";
import type { ScriptedChild } from "./scripted-child";
import { readInbound } from "./transport";

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};

function specFor(overrides: Partial<HostSessionSpec> = {}): HostSessionSpec {
  return {
    mode: "smoke",
    interactionMode: "static",
    pageSlug: "dash",
    sourcePath: "/scratch/candidate.tsx",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    size: { w: 80, h: 24 },
    theme: "dark-default",
    capabilities: { colorDepth: 24 },
    ...overrides,
  };
}

/** The default valid layout tree the double seals into `ready.body.layout` (WP-5 Task A2)
 *  unless `opts.layout` overrides it — every real smoke/export mount carries one per Task
 *  A1, so `runOneShotSession`'s decode boundary requires one too. */
function defaultLayout(spec: HostSessionSpec) {
  return {
    id: "root",
    kind: "BoxRenderable",
    box: { x: 0, y: 0, width: spec.size.w, height: spec.size.h },
    children: [],
  };
}

/** A one-shot host double: handshakes, then on mount seals ready + one frame and exits 0. */
function oneShotChild(
  spec: HostSessionSpec,
  opts?: {
    skipHostHello?: boolean;
    skipFrame?: boolean;
    mountErrorCode?: string;
    /** Override `ready.body.layout` — pass a malformed value to exercise the decode-miss path. */
    layout?: JsonValue;
  },
): ScriptedChild {
  const child = createScriptedChild();
  let id: { sessionId: string; nonce: string } | null = null;
  let messageId = 1n;
  const nextId = () => {
    const value = messageId.toString();
    messageId += 1n;
    return value;
  };
  const send = (env: ControlEnvelope) => {
    const framed = frameControl(env);
    if (!(framed instanceof ProtocolError)) child.emit(framed);
  };
  child.onWrite = (bytes) => void decode(bytes);
  async function decode(bytes: Uint8Array) {
    const carrier = createScriptedChild();
    carrier.emit(bytes);
    carrier.endStdout();
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return;
      if (message.messageClass !== "control") return;
      const raw = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope & {
        kind: string;
      };
      if (raw.kind === "client.hello" && id === null) {
        if (opts?.skipHostHello) return;
        id = { sessionId: raw.sessionId, nonce: raw.nonce };
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
      if (raw.kind === "mount") {
        if (opts?.mountErrorCode !== undefined) {
          send({
            protocolVersion: 1,
            kind: "error",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: raw.requestId,
            body: { code: opts.mountErrorCode, reason: "one-shot mount failed" },
          });
          child.simulateExit({ code: 1 });
          return;
        }
        send({
          protocolVersion: 1,
          kind: "ready",
          sessionId: id.sessionId,
          nonce: id.nonce,
          messageId: nextId(),
          responseTo: raw.requestId,
          body: {
            size: { w: spec.size.w, h: spec.size.h },
            interactionMode: "static",
            layout: opts?.layout !== undefined ? opts.layout : defaultLayout(spec),
          },
        });
        if (opts?.skipFrame) return; // ready but no frame → the runner times out on capture; child stays alive
        const frame: FrameEnvelope = {
          protocolVersion: 1,
          kind: "frame",
          sessionId: id.sessionId,
          nonce: id.nonce,
          sourceHash: spec.sourceHash,
          frameSeq: "1",
          width: spec.size.w,
          height: spec.size.h,
          rows: Array.from({ length: spec.size.h }, () => []),
        };
        const framed = frameFrame(frame);
        if (!(framed instanceof ProtocolError)) child.emit(framed);
        child.simulateExit({ code: 0 }); // §4/§11.3: one-shot exits after the sealed frame
        return;
      }
    }
  }
  return child;
}

async function waitUntil(pred: () => boolean, label: string, tries = 2_000): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

describe("runOneShotSession (2D-4, §4/§11.3/§11.4)", () => {
  test("a smoke session seals one frame, the child exits 0, and it returns a nonce-free result", async () => {
    const spec = specFor({ mode: "smoke" });
    const child = oneShotChild(spec);
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.frame.frameSeq).toBe("1");
    expect(result.frame).not.toHaveProperty("nonce");
    expect(result.identity).not.toHaveProperty("nonce");
    expect(result.exitCode).toBe(0);
    expect(result.ready.kind).toBe("ready");
    expect(clock.pending()).toBe(0); // no leaked timers
  });

  test("an export session also seals one frame and exits", async () => {
    const spec = specFor({ mode: "export" });
    const child = oneShotChild(spec);
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    if (result instanceof Error) throw result;
    expect(result.frame.frameSeq).toBe("1");
    expect(result.identity.mode).toBe("export");
  });

  test("a mount error is returned as a typed failure with NO restart (deterministic code preserved)", async () => {
    const spec = specFor({ mode: "smoke" });
    const child = oneShotChild(spec, { mountErrorCode: "SOURCE_HASH_MISMATCH" });
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) expect(result.code).toBe("SOURCE_HASH_MISMATCH");
  });

  test("no host.hello within 3 s is a HANDSHAKE_TIMEOUT", async () => {
    const spec = specFor({ mode: "smoke" });
    const child = oneShotChild(spec, { skipHostHello: true });
    const clock = createManualClock();
    const promise = runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    await waitUntil(() => clock.pending() >= 1, "handshake timer armed");
    clock.advance(3_000);
    const result = await promise;
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("HANDSHAKE_TIMEOUT");
  });

  test("ready but no sealed frame within 10 s is a capture (MOUNT) timeout", async () => {
    const spec = specFor({ mode: "smoke" });
    const child = oneShotChild(spec, { skipFrame: true });
    const clock = createManualClock();
    const promise = runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    await waitUntil(() => clock.pending() >= 1, "capture timer armed");
    clock.advance(10_000);
    const result = await promise;
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("MOUNT_TIMEOUT");
  });

  test("decodes the ready body's layout tree onto OneShotResult (WP-5 Task A2)", async () => {
    const spec = specFor({ mode: "export" });
    const tree = {
      id: "root",
      kind: "BoxRenderable",
      box: { x: 0, y: 0, width: spec.size.w, height: spec.size.h },
      children: [
        {
          id: "child",
          kind: "TextRenderable",
          box: { x: 1, y: 1, width: 4, height: 1 },
          children: [],
        },
      ],
    };
    const child = oneShotChild(spec, { layout: tree });
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    expect(result.layout).toEqual(tree);
  });

  test("a malformed layout body is a typed ProtocolError, never a fabricated tree", async () => {
    const spec = specFor({ mode: "export" });
    const child = oneShotChild(spec, { layout: { id: "root" } }); // missing kind/box/children
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => child,
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    expect(result).toBeInstanceOf(ProtocolError);
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL");
  });

  test("a non-one-shot mode is refused before spawning", async () => {
    const spec = specFor({ mode: "preview" });
    let spawned = false;
    const clock = createManualClock();
    const result = await runOneShotSession(spec, {
      spawn: () => {
        spawned = true;
        return oneShotChild(spec);
      },
      command: { cmd: ["_host"] },
      clock,
      runtimeDeclaration,
    });
    expect(result).toBeInstanceOf(SupervisorError);
    if (result instanceof SupervisorError) expect(result.code).toBe("TRANSPORT_ERROR");
    expect(spawned).toBe(false);
  });
});

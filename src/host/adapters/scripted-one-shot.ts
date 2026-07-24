// TEST DOUBLE — a scripted one-shot host child: handshakes, then on receiving a `mount`
// either seals `ready` + one frame (clean one-shot success, host-supervision §4/§11.3) or
// replies with a typed `error` envelope (a scripted mount failure). This assembles
// `host/supervisor/model/scripted-child.ts`'s primitives exactly the way
// `host/supervisor/model/one-shot.test.ts` already does for `runOneShotSession` itself —
// it adds no new protocol behavior, it only gives the export-render and smoke-renderer
// adapter suites (both of which drive `runOneShotSession` through a real one-shot wire
// exchange) one shared double instead of two independent copies.
import { ProtocolError } from "../protocol";
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  JsonValue,
  RuntimeDeclarationBundleV1,
} from "../protocol";
import {
  createScriptedChild,
  frameControl,
  frameFrame,
  frameHostHello,
} from "../supervisor/model/scripted-child";
import type { ScriptedChild } from "../supervisor/model/scripted-child";
import { readInbound } from "../supervisor/model/transport";
import type { HostSessionSpec } from "../types";

export const TEST_RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
};

/** The default valid layout tree sealed into `ready.body.layout` unless `opts.layout`
 *  overrides it — every real smoke/export mount carries one (host-state-machine.ts's
 *  `handleMount`, WP-5 Task A1), and `runOneShotSession`'s decode boundary requires one
 *  too (WP-5 Task A2). */
function defaultLayout(spec: HostSessionSpec) {
  return {
    id: "root",
    kind: "BoxRenderable",
    box: { x: 0, y: 0, width: spec.size.w, height: spec.size.h },
    children: [],
  };
}

/**
 * A one-shot host double: handshakes, then on `mount` either seals `ready` + one frame and
 * exits 0 (the default), or replies with a scripted `error` envelope and exits 1 when
 * `mountErrorCode` is given.
 */
export function createOneShotChild(
  spec: HostSessionSpec,
  opts?: { readonly mountErrorCode?: string; readonly layout?: JsonValue },
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

  async function decode(bytes: Uint8Array): Promise<void> {
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
        id = { sessionId: raw.sessionId, nonce: raw.nonce };
        const hostHello: HostHelloV1 = {
          framingVersion: 1,
          kind: "host.hello",
          sessionId: id.sessionId,
          nonce: id.nonce,
          selectedFramingVersion: 1,
          selectedProtocolVersion: 1,
          runtimeDeclaration: TEST_RUNTIME_DECLARATION,
          limits: {
            controlPayloadBytes: 65_536,
            framePayloadBytes: 1_048_576,
            maxFrameWidth: 500,
            maxFrameHeight: 500,
            maxFrameCells: 250_000,
          },
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
            body: { code: opts.mountErrorCode, reason: "scripted one-shot mount failure" },
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
        const frame: FrameEnvelope = {
          protocolVersion: 1,
          kind: "frame",
          sessionId: id.sessionId,
          nonce: id.nonce,
          sourceHash: spec.sourceHash,
          frameSeq: "1",
          width: spec.size.w,
          height: spec.size.h,
          rows: [
            [{ text: "ok", fg: "default", bg: "default", attrs: 0 }],
            ...Array.from({ length: Math.max(0, spec.size.h - 1) }, () => []),
          ],
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

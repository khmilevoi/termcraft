// TEST DOUBLE — a responding fake 2C host that reaches ready and answers post-ready
// requests (ping/resize/set-mode/shutdown), emits frames + heartbeats on demand.
// Shared by session.test.ts and preview-session.test.ts. Not part of the public
// supervisor surface.
import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol"
import type { ControlEnvelope, FrameEnvelope, HostHelloV1, RuntimeDeclarationBundleV1 } from "../../protocol"
// InteractionMode lives in host/types and is NOT re-exported from ../../protocol.
import type { HostSessionSpec, InteractionMode } from "../../types"
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child"
import type { ScriptedChild } from "./scripted-child"
import { readInbound } from "./transport"

export interface LivePreviewChild extends ScriptedChild {
  emitFrame(seq: string): void
  emitHeartbeat(): void
}

export function livePreviewChild(
  spec: HostSessionSpec,
  runtimeDeclaration: RuntimeDeclarationBundleV1,
  options?: {
    setModeEcho?: InteractionMode
    /** Overrides the canned query reply BODY for `query-hit`/`query-rect`/`query-describe`/
     * `query-layout` (blocker B1). Defaults to `{ ok: true, frameIdentity: <as requested>,
     * result: { echoedKind } }` — enough to prove correlation + wire-kind mapping without a
     * real render tree. A test overrides this to script `STALE_FRAME` or a specific result. */
    queryReply?: (wireKind: string, requestBody: Record<string, unknown>) => Record<string, unknown>
  },
): LivePreviewChild {
  const child = createScriptedChild() as LivePreviewChild
  let id: { sessionId: string; nonce: string } | null = null
  let messageId = 1n
  const nextId = () => {
    const value = messageId.toString()
    messageId += 1n
    return value
  }
  const send = (env: ControlEnvelope) => {
    const framed = frameControl(env)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  child.onWrite = (bytes) => void decode(bytes)
  async function decode(bytes: Uint8Array) {
    const carrier = createScriptedChild()
    carrier.emit(bytes)
    carrier.endStdout()
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return
      if (message.messageClass !== "control") return
      const raw = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope & { kind: string }
      if (raw.kind === "client.hello" && id === null) {
        id = { sessionId: raw.sessionId, nonce: raw.nonce }
        const hostHello: HostHelloV1 = {
          framingVersion: 1, kind: "host.hello", sessionId: id.sessionId, nonce: id.nonce,
          selectedFramingVersion: 1, selectedProtocolVersion: 1, runtimeDeclaration, limits: PROTOCOL_HARD_LIMITS,
        }
        const framed = frameHostHello(hostHello)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (id === null) return
      if (raw.kind === "mount") {
        send({ protocolVersion: 1, kind: "ready", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: { w: 80, h: 24 }, interactionMode: "static" } })
        const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: "1", width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
        const framed = frameFrame(frame)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (raw.kind === "ping") return send({ protocolVersion: 1, kind: "pong", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: {} })
      if (raw.kind === "resize") return send({ protocolVersion: 1, kind: "resize", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: raw.body.size! } })
      if (raw.kind === "set-mode") {
        const echo = options?.setModeEcho ?? (raw.body.interactionMode as InteractionMode)
        return send({ protocolVersion: 1, kind: "set-mode", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { interactionMode: echo } })
      }
      if (raw.kind === "query-hit" || raw.kind === "query-rect" || raw.kind === "query-describe" || raw.kind === "query-layout") {
        const requestBody = raw.body as unknown as Record<string, unknown>
        const replyBody = options?.queryReply
          ? options.queryReply(raw.kind, requestBody)
          : { ok: true, frameIdentity: requestBody.frameIdentity, result: { echoedKind: raw.kind } }
        return send({ protocolVersion: 1, kind: raw.kind, sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: replyBody as ControlEnvelope["body"] })
      }
      if (raw.kind === "shutdown") {
        send({ protocolVersion: 1, kind: "shutdown-ack", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { ok: true } })
        child.simulateExit({ code: 0 })
        return
      }
    }
  }
  child.emitFrame = (seq) => {
    if (id === null) return
    const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: seq, width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
    const framed = frameFrame(frame)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  child.emitHeartbeat = () => {
    if (id === null) return
    send({ protocolVersion: 1, kind: "heartbeat", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), body: {} })
  }
  return child
}

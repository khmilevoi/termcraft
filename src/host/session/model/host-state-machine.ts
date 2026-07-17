import {
  decodeClientHello,
  ProtocolError,
  type HostHelloV1,
  type PublicLimits,
} from "../../protocol"
import type { HostSession, HostSessionDeps, OutboundMessage } from "../types"

type Phase = "awaiting-hello" | "awaiting-mount" | "ready" | "closed"

/**
 * The host-side protocol driver (host-supervision §6-§7). It consumes decoded
 * control-class payloads and emits logical outbound messages through `deps.send`,
 * so it is testable without real stdio. State transitions are serialized: the
 * entry awaits each `receiveControlPayload` before feeding the next, so wire order
 * is process order (§7). A fatal `ProtocolError` past handshake emits a best-effort
 * `error` envelope, then requests exit; before handshake it only requests exit
 * (no identity to echo).
 */
export function createHostSession(deps: HostSessionDeps): HostSession {
  let phase: Phase = "awaiting-hello"
  let identity: { sessionId: string; nonce: string } | null = null
  let messageCounter = 1n

  const nextMessageId = () => {
    const id = messageCounter.toString()
    messageCounter += 1n
    return id
  }

  async function receiveControlPayload(payload: Uint8Array): Promise<void> {
    if (phase === "closed") return
    if (phase === "awaiting-hello") return handleHello(payload)
    // Tasks 7-8 dispatch mount/resize/set-mode/ping/shutdown here.
    fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `unexpected message in phase ${phase}` }))
  }

  function handleHello(payload: Uint8Array): void {
    const hello = decodeClientHello(payload)
    if (hello instanceof ProtocolError) return failPreHandshake(hello)

    identity = { sessionId: hello.sessionId, nonce: hello.nonce }
    const hostHello: HostHelloV1 = {
      framingVersion: 1,
      kind: "host.hello",
      sessionId: hello.sessionId,
      nonce: hello.nonce,
      selectedFramingVersion: 1,
      selectedProtocolVersion: 1,
      runtimeDeclaration: deps.runtimeDeclaration,
      limits: negotiateLimits(hello.limits),
    }
    deps.send({ type: "host-hello", payload: hostHello })
    phase = "awaiting-mount"
  }

  /** Effective limits are the per-field minimum of client offer and host caps (§6). */
  function negotiateLimits(client: PublicLimits): PublicLimits {
    const cap = deps.limits
    return {
      controlPayloadBytes: Math.min(client.controlPayloadBytes, cap.controlPayloadBytes),
      framePayloadBytes: Math.min(client.framePayloadBytes, cap.framePayloadBytes),
      maxFrameWidth: Math.min(client.maxFrameWidth, cap.maxFrameWidth),
      maxFrameHeight: Math.min(client.maxFrameHeight, cap.maxFrameHeight),
      maxFrameCells: Math.min(client.maxFrameCells, cap.maxFrameCells),
    }
  }

  /** Pre-handshake fatal: no identity to echo, so just exit (supervisor's 3s deadline). */
  function failPreHandshake(error: ProtocolError): void {
    phase = "closed"
    deps.requestExit({ code: 1, reason: String(error.reason) })
  }

  /** Post-handshake fatal: emit a best-effort typed `error`, then exit (§12). */
  function fail(error: ProtocolError): void {
    if (identity !== null) {
      deps.send({
        type: "control",
        payload: {
          protocolVersion: 1,
          kind: "error",
          sessionId: identity.sessionId,
          nonce: identity.nonce,
          messageId: nextMessageId(),
          body: { code: error.code, reason: error.reason },
        },
      })
    }
    phase = "closed"
    deps.requestExit({ code: 1, reason: String(error.reason) })
  }

  function emitHeartbeat(): void {
    // Implemented in Task 8.
  }

  return { receiveControlPayload, emitHeartbeat }
}

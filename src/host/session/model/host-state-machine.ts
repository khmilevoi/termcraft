import { createElement } from "@opentui/react"

import {
  decodeClientHello,
  decodeControlEnvelope,
  ProtocolError,
  type ControlEnvelope,
  type FrameEnvelope,
  type FrameIdentity,
  type HostHelloV1,
  type PublicLimits,
} from "../../protocol"
import type { RenderHandle } from "../../render"
import type { HostMode, InteractionMode } from "../../types"
import type { HostSession, HostSessionDeps, MountRequestBody, OutboundMessage, ReadyBody } from "../types"

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

  let renderer: RenderHandle | null = null
  let sourceHash: string | null = null
  let mountedMode: HostMode | null = null
  let frameCounter = 1n
  let lastFrameSeq = "0"
  let effectiveMode: InteractionMode = "static"

  const nextMessageId = () => {
    const id = messageCounter.toString()
    messageCounter += 1n
    return id
  }

  async function receiveControlPayload(payload: Uint8Array): Promise<void> {
    if (phase === "closed") return
    if (phase === "awaiting-hello") return handleHello(payload)

    const envelope = decodeControlEnvelope(payload)
    if (envelope instanceof ProtocolError) return fail(envelope)
    const identityError = checkIdentity(envelope)
    if (identityError instanceof ProtocolError) return fail(identityError)

    if (phase === "awaiting-mount") {
      if (envelope.kind === "mount") return handleMount(envelope)
      // Task 8 adds `shutdown` acceptance in this phase (§6: shutdown valid pre-ready).
      return fail(unknownKind(envelope.kind, phase))
    }
    // phase === "ready" — resize/set-mode/ping/shutdown handled in Task 8.
    return fail(unknownKind(envelope.kind, phase))
  }

  function checkIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (identity === null) return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "no negotiated identity" })
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "envelope identity does not match the negotiated session" })
    }
    return null
  }

  function unknownKind(kind: string, inPhase: Phase): ProtocolError {
    return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `kind ${JSON.stringify(kind)} is not accepted in phase ${inPhase}` })
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

  async function handleMount(envelope: ControlEnvelope): Promise<void> {
    if (envelope.requestId === undefined) return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "mount must carry a requestId" }))
    const request = parseMountRequest(envelope.body)
    if (request instanceof ProtocolError) return fail(request)

    const loaded = await deps.loadPage({
      sourcePath: request.sourcePath,
      expectedSourceHash: request.expectedSourceHash,
    })
    if (loaded instanceof ProtocolError) return fail(loaded)

    const handle = await deps.createRenderer(request.size)
    renderer = handle
    sourceHash = loaded.sourceHash
    mountedMode = request.mode

    handle.mount(createElement(loaded.component as never))
    await handle.render()
    const captured = handle.capture()

    const frameIdentity = sealFrameIdentity()
    // §4: only preview honors a requested interactive mode; historical/smoke/export
    // are always effectively static.
    const initialMode: InteractionMode =
      request.mode === "preview" ? request.interactionMode : "static"

    const readyBody: ReadyBody = {
      meta: loaded.meta,
      size: { w: captured.width, h: captured.height },
      interactionMode: initialMode,
      frameIdentity,
      tweaks: [],
    }
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind: "ready",
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        responseTo: envelope.requestId,
        body: readyBody as unknown as ControlEnvelope["body"],
      },
    })
    emitFrame(captured, frameIdentity)
    lastFrameSeq = frameIdentity.frameSeq
    effectiveMode = initialMode
    phase = "ready"

    // §11.3/§11.4: smoke and export are one-shot. Both exit 0 after the first
    // frame (Spike D — the entry, not this handler, calls process.exit). NOTE:
    // export's `frame` here is the documented non-conformant MVP stand-in (see
    // Scope); the conformant `capture`+layout reply is deferred to 2D.
    if (request.mode === "smoke" || request.mode === "export") {
      phase = "closed"
      deps.requestExit({ code: 0, reason: `${request.mode} one-shot complete` })
    }
  }

  function sealFrameIdentity(): FrameIdentity {
    const frameSeq = frameCounter.toString()
    frameCounter += 1n
    return {
      sessionId: identity!.sessionId,
      nonce: identity!.nonce,
      sourceHash: sourceHash!,
      frameSeq,
    }
  }

  function emitFrame(captured: { width: number; height: number; rows: FrameEnvelope["rows"] }, frameIdentity: FrameIdentity): void {
    const frame: FrameEnvelope = {
      protocolVersion: 1,
      kind: "frame",
      sessionId: frameIdentity.sessionId,
      nonce: frameIdentity.nonce,
      sourceHash: frameIdentity.sourceHash,
      frameSeq: frameIdentity.frameSeq,
      width: captured.width,
      height: captured.height,
      rows: captured.rows,
    }
    deps.send({ type: "frame", payload: frame })
  }

  function parseMountRequest(body: ControlEnvelope["body"]): ProtocolError | MountRequestBody {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })
    const sourcePath = body.sourcePath
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.length > 4096) return bad("mount.sourcePath must be a bounded non-empty string")
    const expectedSourceHash = body.expectedSourceHash
    if (typeof expectedSourceHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedSourceHash)) return bad("mount.expectedSourceHash must be 64 lowercase hex")
    const mode = body.mode
    if (mode !== "preview" && mode !== "historical" && mode !== "smoke" && mode !== "export") return bad("mount.mode must be a host mode")
    const interactionMode = body.interactionMode
    if (interactionMode !== "static" && interactionMode !== "interactive") return bad("mount.interactionMode must be static|interactive")
    const size = parseSize(body.size)
    if (size instanceof ProtocolError) return size
    const theme = body.theme
    if (typeof theme !== "string" || theme.length === 0 || theme.length > 64) return bad("mount.theme must be a bounded non-empty string")
    const capabilities = body.capabilities
    if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return bad("mount.capabilities must be an object")
    const colorDepth = (capabilities as { colorDepth?: unknown }).colorDepth
    if (typeof colorDepth !== "number" || !Number.isSafeInteger(colorDepth) || colorDepth <= 0) return bad("mount.capabilities.colorDepth must be a positive integer")
    const deterministic = body.deterministic
    if (typeof deterministic !== "boolean") return bad("mount.deterministic must be a boolean")
    return { sourcePath, expectedSourceHash, mode, interactionMode, size, theme, capabilities: { colorDepth }, deterministic }
  }

  // The param is widened to `| undefined`: callers pass element-access expressions
  // (`body.size`) which are `JsonValue | undefined` under noUncheckedIndexedAccess,
  // whereas the bare indexed-access type is not. The first guard rejects undefined.
  function parseSize(value: ControlEnvelope["body"][string] | undefined): ProtocolError | { w: number; h: number } {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return bad("size must be an object")
    const w = (value as { w?: unknown }).w
    const h = (value as { h?: unknown }).h
    if (typeof w !== "number" || !Number.isSafeInteger(w) || w <= 0 || w > 2048) return bad("size.w must be a positive integer <= 2048")
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || h > 2048) return bad("size.h must be a positive integer <= 2048")
    return { w, h }
  }

  function emitHeartbeat(): void {
    // Implemented in Task 8.
  }

  return { receiveControlPayload, emitHeartbeat }
}

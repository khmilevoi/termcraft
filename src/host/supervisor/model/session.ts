import {
  decodeControlEnvelope,
  decodeFrameEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
} from "../../protocol"
import type { ControlEnvelope, FrameEnvelope, ProtocolViolationCode, PublicLimits } from "../../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../../types"
import { SupervisorError } from "./errors"
import { buildClientHello, verifyHostHello } from "./handshake"
import { mintIdentity } from "./identity"
import { createStderrDrain, readInbound, writeFramed } from "./transport"
import type { InboundMessage } from "./transport"
import type { TimerHandle } from "./clock"
import type {
  HostSession,
  HostSessionDeps,
  ReadyOutcome,
  SessionPhase,
  SpawnedChild,
  StopOutcome,
} from "../types"

const HANDSHAKE_TIMEOUT_MS = 3_000
const MOUNT_TIMEOUT_MS = 10_000
const SHUTDOWN_ACK_TIMEOUT_MS = 1_000
const REAP_TIMEOUT_MS = 1_000

/**
 * Create a session that drives ONE incarnation: spawn → negotiate → mount →
 * ready, then graceful/forced stop → reap (§6, §9, §10). A single serialized
 * driver owns the child, the inbound iterator, the stderr drain, and every
 * timer, with explicit teardown on every exit path (never a Reatom connect hook).
 */
export function createHostSession(spec: HostSessionSpec, deps: HostSessionDeps): HostSession {
  const offeredLimits = deps.offeredLimits ?? PROTOCOL_HARD_LIMITS
  const identity = mintIdentity(spec, deps.sessionId)
  let phase: SessionPhase = "created"

  let child: SpawnedChild | null = null
  let stderrDrain: ReturnType<typeof createStderrDrain> | null = null
  let inbound: AsyncGenerator<ProtocolError | SupervisorError | InboundMessage> | null = null
  // Two independent monotonic decimal-uint64 sequences per (sender, nonce): the
  // envelope messageId (1,2,3,… contiguous, §5.2) and the request correlation id
  // (its own 1,2,3,…) echoed back in responseTo. Drawing both from one counter
  // makes messageId non-contiguous (2,4,…) and never "1" (review Finding #8).
  let messageCounter = 1n
  const nextMessageId = () => {
    const value = messageCounter.toString()
    messageCounter += 1n
    return value
  }
  let requestCounter = 1n
  const nextRequestId = () => {
    const value = requestCounter.toString()
    requestCounter += 1n
    return value
  }

  // A single-consumer pull over the inbound iterator against an ABSOLUTE deadline.
  // The timer duration is `deadlineAt - now` each call, so a loop that consumes
  // several messages (awaitReady/awaitShutdownAck) keeps ONE total bound instead of
  // re-arming the full duration per message (review Findings #3/#9). Every timeout
  // path tears the session down, so the abandoned `inbound.next()` on a timeout is
  // settled by `inbound.return()` in teardown/stop and never eaten by a later pull.
  async function nextInbound(deadlineAt: number, timeoutError: SupervisorError): Promise<ProtocolError | SupervisorError | InboundMessage> {
    if (inbound === null) return new SupervisorError({ code: "TRANSPORT_ERROR", reason: "no inbound iterator" })
    let timer: TimerHandle | null = null
    const timeout = new Promise<SupervisorError>((resolve) => {
      const remaining = Math.max(0, deadlineAt - deps.clock.now())
      timer = deps.clock.setTimer(remaining, () => resolve(timeoutError))
    })
    const next = inbound.next().then((result) => (result.done ? new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed before the expected message" }) : result.value))
    const winner = await Promise.race([next, timeout])
    timer?.cancel()
    return winner
  }

  async function start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
    if (phase !== "created") {
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: `start() is only valid from "created" (was "${phase}")` })
    }
    phase = "spawning"
    const spawned = deps.spawn(deps.command)
    if (spawned instanceof SupervisorError) {
      phase = "failed"
      return spawned
    }
    child = spawned
    stderrDrain = createStderrDrain(spawned)
    inbound = readInbound(spawned)

    // --- negotiate: send client.hello, await host.hello within 3s ---
    phase = "negotiating"
    const clientHello = buildClientHello({ spec, identity, runtimeDeclaration: deps.runtimeDeclaration, offeredLimits })
    const helloBytes = encodeClientHello(clientHello)
    if (helloBytes instanceof ProtocolError) return failWith(helloBytes)
    const sent = await writeFramed(spawned, helloBytes)
    if (sent instanceof SupervisorError) return failWith(sent)

    const handshakeDeadlineAt = deps.clock.now() + HANDSHAKE_TIMEOUT_MS
    const helloMessage = await nextInbound(handshakeDeadlineAt, new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: "no host.hello within 3s" }))
    if (helloMessage instanceof Error) return failWith(helloMessage)
    if (helloMessage.messageClass !== "control") return failWith(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "expected a control-class host.hello" }))
    const hostHello = decodeHostHello(helloMessage.payload)
    if (hostHello instanceof ProtocolError) return failWith(hostHello)
    const negotiation = verifyHostHello(hostHello, { spec, identity, runtimeDeclaration: deps.runtimeDeclaration, offeredLimits })
    if (negotiation instanceof ProtocolError) return failWith(negotiation)

    // --- mount: send correlated mount request, await ready within 10s ---
    phase = "mounting"
    const mountRequestId = nextRequestId()
    const mount: ControlEnvelope = {
      protocolVersion: 1,
      kind: "mount",
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId: mountRequestId,
      body: {
        sourcePath: spec.sourcePath,
        expectedSourceHash: spec.sourceHash,
        mode: spec.mode,
        interactionMode: spec.interactionMode,
        size: { w: spec.size.w, h: spec.size.h },
        theme: spec.theme,
        capabilities: { colorDepth: spec.capabilities.colorDepth },
        deterministic: spec.mode === "export" || spec.mode === "smoke",
      },
    }
    const mountBytes = encodeControlEnvelope(mount)
    if (mountBytes instanceof ProtocolError) return failWith(mountBytes)
    const mountSent = await writeFramed(spawned, mountBytes)
    if (mountSent instanceof SupervisorError) return failWith(mountSent)

    const mountDeadlineAt = deps.clock.now() + MOUNT_TIMEOUT_MS
    const readyResult = await awaitReady(mountRequestId, mountDeadlineAt)
    if (readyResult instanceof Error) return failWith(readyResult)

    phase = "ready"
    return {
      identity,
      negotiatedLimits: negotiation.negotiatedLimits,
      ready: readyResult.ready,
      firstFrame: readyResult.firstFrame,
    }
  }

  // Await the correlated `ready` (§6.6) AND the initial full frame under ONE total
  // 10s deadline, in EITHER order — the 2C child sends `ready` first then the frame,
  // so a version that returned on `ready` alone would always yield firstFrame=null
  // (review Findings #5/#10/#13/#14). Return once BOTH have arrived. A pre-ready
  // `error` envelope is a typed startup failure preserving the child's own code.
  async function awaitReady(
    mountRequestId: string,
    deadlineAt: number,
  ): Promise<ProtocolError | SupervisorError | { ready: ControlEnvelope; firstFrame: FrameEnvelope }> {
    let ready: ControlEnvelope | null = null
    let firstFrame: FrameEnvelope | null = null
    const timeoutError = new SupervisorError({ code: "MOUNT_TIMEOUT", reason: "no ready + first frame within 10s" })
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError)
      if (message instanceof Error) return message
      if (message.messageClass === "data") {
        const frame = decodeFrameEnvelope(message.payload)
        if (frame instanceof ProtocolError) return frame
        const identityError = checkFrameIdentity(frame)
        if (identityError instanceof ProtocolError) return identityError
        if (firstFrame === null) {
          firstFrame = frame
          deps.onFrame?.(frame)
        }
        if (ready !== null) return { ready, firstFrame }
        continue
      }
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) return envelope
      const identityError = checkEnvelopeIdentity(envelope)
      if (identityError instanceof ProtocolError) return identityError
      if (envelope.kind === "ready" && envelope.responseTo === mountRequestId) {
        ready = envelope
        if (firstFrame !== null) return { ready, firstFrame }
        continue
      }
      if (envelope.kind === "error") return mapHostError(envelope)
      if (envelope.kind === "heartbeat") continue
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `unexpected ${envelope.kind} before ready` })
    }
  }

  // §12: a child `error` at mount carries a typed `body.code`. Preserve deterministic
  // protocol codes (SOURCE_HASH_MISMATCH / KIT_API_MISMATCH / MALFORMED_PROTOCOL /
  // OVERSIZED_MESSAGE / FRAME_TOO_LARGE / …) as a ProtocolError so 2D-3 opens the
  // circuit instead of mislabeling them as a restartable DESIGN_RENDER_FAILED
  // (review Findings #7/#12). An untyped/render error stays DESIGN_RENDER_FAILED.
  const PROTOCOL_ERROR_CODES = new Set<string>([
    "MALFORMED_PROTOCOL",
    "OVERSIZED_MESSAGE",
    "FRAME_TOO_LARGE",
    "PROTOCOL_NEGOTIATION_FAILED",
    "RUNTIME_INTEGRITY_MISMATCH",
    "KIT_API_MISMATCH",
    "SOURCE_HASH_MISMATCH",
  ])
  function mapHostError(envelope: ControlEnvelope): ProtocolError | SupervisorError {
    const code = envelope.body.code
    const rawReason = envelope.body.reason
    const reason = typeof rawReason === "string" ? rawReason.slice(0, 200) : "host error during mount"
    if (typeof code === "string" && PROTOCOL_ERROR_CODES.has(code)) {
      return new ProtocolError({ code: code as ProtocolViolationCode, reason })
    }
    return new SupervisorError({ code: "DESIGN_RENDER_FAILED", reason: typeof code === "string" ? `${code}: ${reason}` : reason })
  }

  function checkEnvelopeIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "inbound envelope identity does not match the incarnation" })
    }
    return null
  }
  function checkFrameIdentity(frame: FrameEnvelope): ProtocolError | null {
    if (frame.sessionId !== identity.sessionId || frame.nonce !== identity.nonce || frame.sourceHash !== identity.sourceHash) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "inbound frame identity does not match the incarnation" })
    }
    return null
  }

  // Kill + reap the child and tear down all resources; used on every failure path.
  async function failWith<E extends ProtocolError | SupervisorError>(error: E): Promise<E> {
    await teardown(true)
    phase = "failed"
    return error
  }

  // Reap a child under a bounded §9 reap deadline (1s), then re-kill if it somehow
  // has not exited — never an unbounded `await exited` (review Finding #4). D2: a
  // second kill and a repeat `await exited` are safe/idempotent; OS kill is terminal.
  async function reapChild(target: SpawnedChild, forceKill: boolean): Promise<void> {
    if (forceKill) target.kill()
    let reapTimer: TimerHandle | null = null
    const reapDeadline = new Promise<"reap-timeout">((resolve) => {
      reapTimer = deps.clock.setTimer(REAP_TIMEOUT_MS, () => resolve("reap-timeout"))
    })
    const exit = target.exited.then(() => "exited" as const)
    const reaped = await Promise.race([exit, reapDeadline])
    reapTimer?.cancel()
    if (reaped === "reap-timeout") {
      console.warn("host-supervisor: process did not reap within 1s; re-killing")
      target.kill()
      await target.exited
    }
  }

  async function teardown(kill: boolean): Promise<void> {
    if (child !== null) await reapChild(child, kill)
    stderrDrain?.stop()
    if (stderrDrain !== null) await stderrDrain.settled
    await inbound?.return?.(undefined)
  }

  async function stop(): Promise<StopOutcome> {
    if (phase === "stopped") {
      return { phase: "stopped", forced: false, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: "already stopped" }
    }
    if (child === null || phase !== "ready") {
      // Nothing live to shut down gracefully — force teardown.
      const fromPhase = phase
      await teardown(true)
      phase = "stopped"
      return { phase: "stopped", forced: true, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: `forced stop from phase ${fromPhase}` }
    }
    phase = "stopping"
    const activeChild = child

    // Graceful: send correlated shutdown, await ack within 1s (§9).
    const shutdownRequestId = nextRequestId()
    const shutdown: ControlEnvelope = {
      protocolVersion: 1,
      kind: "shutdown",
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId: shutdownRequestId,
      body: {},
    }
    const bytes = encodeControlEnvelope(shutdown)
    // Each dropped error is logged (errore rule 21 — never a silent swallow) AND its
    // code threaded into StopOutcome.reason so the timeout/transport failure is
    // "retained in diagnostics" (§12, review Finding #2). `null` = graceful.
    const forcing = await (async (): Promise<null | { reason: string }> => {
      if (bytes instanceof ProtocolError) {
        console.warn("host-supervisor: shutdown encode failed, forcing:", bytes.message)
        return { reason: `forced: shutdown encode failed [${bytes.code}]` }
      }
      const sent = await writeFramed(activeChild, bytes)
      if (sent instanceof SupervisorError) {
        console.warn("host-supervisor: shutdown write failed, forcing:", sent.message)
        return { reason: `forced: shutdown write failed [${sent.code}]` }
      }
      const ackDeadlineAt = deps.clock.now() + SHUTDOWN_ACK_TIMEOUT_MS
      const ack = await awaitShutdownAck(shutdownRequestId, ackDeadlineAt)
      if (ack instanceof Error) {
        const code = ack instanceof SupervisorError || ack instanceof ProtocolError ? ack.code : "UNKNOWN"
        console.warn("host-supervisor: no shutdown-ack, forcing:", ack.message)
        return { reason: `forced: no shutdown-ack [${code}]` }
      }
      // Graceful ack received: close stdin and let reapChild await a clean exit
      // (bounded by the reap deadline; it re-kills only if the exit deadline expires).
      activeChild.stdin.end()
      return null
    })()

    await reapChild(activeChild, forcing !== null)
    stderrDrain?.stop()
    if (stderrDrain !== null) await stderrDrain.settled
    await inbound?.return?.(undefined)
    phase = "stopped"
    return {
      phase: "stopped",
      forced: forcing !== null,
      exitCode: activeChild.exitCode,
      signalCode: activeChild.signalCode,
      reason: forcing?.reason ?? "graceful shutdown",
    }
  }

  async function awaitShutdownAck(requestId: string, deadlineAt: number): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    const timeoutError = new SupervisorError({ code: "SHUTDOWN_TIMEOUT", reason: "no shutdown-ack within 1s" })
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError)
      if (message instanceof Error) return message
      if (message.messageClass === "data") continue // late frame; ignore during stop
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) return envelope
      if (envelope.kind === "shutdown-ack" && envelope.responseTo === requestId) return envelope
      // route other post-ready control events to the sink but keep waiting
      deps.onControlEvent?.({ kind: envelope.kind, envelope })
    }
  }

  return {
    identity,
    get phase() {
      return phase
    },
    start,
    stop,
  }
}

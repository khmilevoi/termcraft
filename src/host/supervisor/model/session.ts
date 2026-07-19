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
// NOTE: session.ts ALREADY imports decodeControlEnvelope + decodeFrameEnvelope from
// "../../protocol" (top import block, used by awaitReady, retained per §4h) — do NOT
// re-add them here or tsc fails with TS2300 "Duplicate identifier".
import type { InteractionMode, PreviewFrame, Size } from "../../types"
import { createFrameBroker } from "./frame-broker"
import { createRequestTable, REQUEST_TABLE_CAPACITY } from "./request-table"
import { createHeartbeatWatchdog } from "./heartbeat-watchdog"
import { createFloodMonitor } from "./flood-monitor"
import type {
  FloodMonitor,
  FrameBroker,
  HeartbeatWatchdog,
  HostSession,
  HostSessionDeps,
  ReadyOutcome,
  RequestTable,
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

  // Post-ready components. The watchdog escalation and the request-table timeout
  // are wired to the single fatal path (declared as hoisted functions below).
  const watchdog: HeartbeatWatchdog = (deps.createWatchdog ?? createHeartbeatWatchdog)(deps.clock, {
    onUnhealthy: (error) => onPumpFatal(error),
  })
  const requestTable: RequestTable = (deps.createRequestTable ?? createRequestTable)(deps.clock, {
    onTimeout: () => watchdog.noteRequestTimeout(),
  })
  const broker: FrameBroker = (deps.createBroker ?? createFrameBroker)({
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    sourceHash: identity.sourceHash,
  })
  // §8 rolling-second output flood detection. Metered on RAW inbound payload bytes
  // (before decode/coalescing), so a 2000-frame/s or >128 MiB/s or >1 MiB/s-stderr
  // child trips PROTOCOL_FLOOD / STDERR_FLOOD → onPumpFatal → deterministic circuit-open.
  const floodMonitor: FloodMonitor = (deps.createFloodMonitor ?? createFloodMonitor)(deps.clock)
  let pumpTask: Promise<void> = Promise.resolve()

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
    // Bind the timer to a `const` from `setTimer` directly (not via a closure
    // assignment inside the Promise executor, which TS 7 narrows to `never`).
    let resolveTimeout!: (error: SupervisorError) => void
    const timeout = new Promise<SupervisorError>((resolve) => { resolveTimeout = resolve })
    const remaining = Math.max(0, deadlineAt - deps.clock.now())
    const timer = deps.clock.setTimer(remaining, () => resolveTimeout(timeoutError))
    const next = inbound.next().then((result) => (result.done ? new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed before the expected message" }) : result.value))
    const winner = await Promise.race([next, timeout])
    timer.cancel()
    return winner
  }

  async function start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
    if (phase !== "created") {
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: `start() is only valid from "created" (was "${phase}")` })
    }
    phase = "spawning"
    const spawned = deps.spawn(deps.command)
    if (spawned instanceof SupervisorError) {
      broker.close() // end the frame iterator; there is no child/inbound/drain to reap yet
      phase = "failed"
      return spawned
    }
    child = spawned
    stderrDrain = createStderrDrain(spawned, { floodMonitor, onFlood: (error) => onPumpFatal(error) })
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
    startPump(readyResult.firstFrame)
    return {
      identity,
      negotiatedLimits: negotiation.negotiatedLimits,
      ready: readyResult.ready,
      firstFrame: readyResult.firstFrame,
    }
  }

  function startPump(firstFrame: FrameEnvelope): void {
    // Publish the already-captured first frame so the initial displayed frame is
    // not dropped (brief §6 Q2). The broker's guard re-validates it.
    broker.publish(firstFrame)
    watchdog.start()
    pumpTask = runPump()
  }

  // The SOLE reader of `inbound` from `ready` onward (brief invariant 1). A bare
  // for-await with no per-message deadline — liveness is the watchdog's job
  // (brief §6 Q1). Every fatal exit routes through onPumpFatal; teardown settles
  // the suspended next() via inbound.return(), so nothing leaks.
  async function runPump(): Promise<void> {
    if (inbound === null) return
    for await (const message of inbound) {
      if (message instanceof Error) {
        onPumpFatal(message)
        return
      }
      if (message.messageClass === "data") {
        // §8 flood metering on the RAW encoded payload, before decode/coalescing.
        const flood = floodMonitor.noteFrame(message.payload.byteLength)
        if (flood instanceof SupervisorError) {
          onPumpFatal(flood)
          return
        }
        const frame = decodeFrameEnvelope(message.payload)
        if (frame instanceof ProtocolError) {
          onPumpFatal(frame)
          return
        }
        // §10.1/§5.3/§12: a frame's identity + monotonic frameSeq are FATAL for the
        // live child, not a silent drop. 2D-1 awaitReady already enforced
        // checkFrameIdentity fatally; with ONE incarnation there is no cross-nonce
        // noise yet, so a mismatch is a real violation → terminate + MALFORMED_PROTOCOL.
        const frameIdentityError = checkFrameIdentity(frame)
        if (frameIdentityError instanceof ProtocolError) {
          onPumpFatal(frameIdentityError)
          return
        }
        // Identity passed, so a broker "stale" can only be a non-monotonic frameSeq
        // from the current incarnation — also a fatal §5.3 violation, not a drop.
        if (broker.publish(frame) === "stale") {
          onPumpFatal(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `non-monotonic frameSeq ${frame.frameSeq}` }))
          return
        }
        continue
      }
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) {
        onPumpFatal(envelope)
        return
      }
      const identityError = checkEnvelopeIdentity(envelope)
      if (identityError instanceof ProtocolError) {
        onPumpFatal(identityError)
        return
      }
      if (envelope.responseTo !== undefined) {
        requestTable.resolve(envelope.responseTo, envelope)
        continue
      }
      if (envelope.kind === "error") {
        onPumpFatal(mapHostError(envelope))
        return
      }
      if (envelope.kind === "heartbeat") {
        watchdog.feedHeartbeat()
        continue
      }
      deps.onControlEvent?.({ kind: envelope.kind, envelope })
    }
    // inbound ended. If we were still ready, the child exited unexpectedly.
    if (phase === "ready") onPumpFatal(new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed while ready" }))
  }

  // The single fatal entry point for the pump AND the watchdog. It always settles
  // outstanding requests with the exact error (so a concurrent stop() resolves
  // immediately with this code, not a 1 s timeout), then — only if still `ready` —
  // owns the async teardown to `failed`. If we are already stopping/stopped/failed,
  // that path owns teardown.
  function onPumpFatal(error: ProtocolError | SupervisorError): void {
    requestTable.clear(error)
    if (phase === "ready") failFromReady(error)
  }

  function failFromReady(error: ProtocolError | SupervisorError): void {
    if (phase !== "ready") return
    phase = "failed"
    broker.close()
    watchdog.stop()
    void finalizeFatalTeardown(error)
  }

  async function finalizeFatalTeardown(error: ProtocolError | SupervisorError): Promise<void> {
    // teardown(true) kills+reaps the child and calls inbound.return(), which ends
    // the pump loop. We do NOT await pumpTask here: when this runs from inside the
    // pump the await would deadlock; inbound.return() settles it regardless.
    await teardown(true)
    if (deps.onFatal) deps.onFatal(error)
    else console.warn("host-supervisor: post-ready fatal outcome with no onFatal sink:", error.message)
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

  async function sendRequest(kind: string, body: ControlEnvelope["body"]): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    if (phase !== "ready" || child === null) {
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: `${kind} requires a ready session (was "${phase}")` })
    }
    // Reject before send when the table is full (§8), so no envelope is written.
    if (requestTable.size() >= REQUEST_TABLE_CAPACITY) {
      return new SupervisorError({ code: "TOO_MANY_REQUESTS", reason: `request table full (${REQUEST_TABLE_CAPACITY})` })
    }
    const requestId = nextRequestId()
    const promise = requestTable.register(requestId, kind)
    const envelope: ControlEnvelope = {
      protocolVersion: 1,
      kind,
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId,
      body,
    }
    const bytes = encodeControlEnvelope(envelope)
    if (bytes instanceof ProtocolError) {
      requestTable.supersede(requestId, `${kind} encode failed [${bytes.code}]`)
      return bytes
    }
    const sent = await writeFramed(child, bytes)
    if (sent instanceof SupervisorError) {
      requestTable.supersede(requestId, `${kind} write failed [${sent.code}]`)
      return sent
    }
    return promise
  }

  const resize = (size: Size) => sendRequest("resize", { size: { w: size.w, h: size.h } })
  const setMode = (mode: InteractionMode) => sendRequest("set-mode", { interactionMode: mode })
  const ping = () => sendRequest("ping", {})

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
    let resolveReap!: (value: "reap-timeout") => void
    const reapDeadline = new Promise<"reap-timeout">((resolve) => { resolveReap = resolve })
    const reapTimer = deps.clock.setTimer(REAP_TIMEOUT_MS, () => resolveReap("reap-timeout"))
    const exit = target.exited.then(() => "exited" as const)
    const reaped = await Promise.race([exit, reapDeadline])
    reapTimer.cancel()
    if (reaped === "reap-timeout") {
      console.warn("host-supervisor: process did not reap within 1s; re-killing")
      target.kill()
      await target.exited
    }
  }

  async function teardown(kill: boolean): Promise<void> {
    broker.close()        // ends the frame iterator on every exit path (§10.1, brief invariant 5)
    watchdog.stop()       // idempotent; no-op if never started (pre-ready)
    requestTable.clear()  // settles stragglers; no-op if empty (a post-ready fatal already cleared with the specific error)
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
      const fromPhase = phase
      await teardown(true) // teardown() now closes the broker + clears the table + stops the watchdog
      await pumpTask
      phase = "stopped"
      return { phase: "stopped", forced: true, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: `forced stop from phase ${fromPhase}` }
    }
    phase = "stopping"
    const activeChild = child

    // Unlike sendRequest, a full table here would still let register() succeed
    // (it only rejects at its OWN capacity), but the shutdown's ack could never be
    // told apart from a coincidental slot reuse in a genuinely full table — and a
    // doomed, uncorrelatable graceful attempt just wastes the 1 s ack deadline
    // before falling back anyway. Check the SAME pre-send guard sendRequest uses
    // (§8) BEFORE writing anything, and force immediately if the table is full.
    if (requestTable.size() >= REQUEST_TABLE_CAPACITY) {
      console.warn("host-supervisor: request table full at stop(); forcing")
      await teardown(true)
      await pumpTask
      phase = "stopped"
      return {
        phase: "stopped",
        forced: true,
        exitCode: activeChild.exitCode,
        signalCode: activeChild.signalCode,
        reason: "forced: request table full at shutdown",
      }
    }

    // Graceful: register the shutdown so the pump can route its ack, send it, then
    // await the ack under a dedicated 1 s deadline (§9). The pump remains the sole
    // reader; stop() never pulls inbound.
    const shutdownRequestId = nextRequestId()
    const ackPromise = requestTable.register(shutdownRequestId, "shutdown")
    const shutdown: ControlEnvelope = {
      protocolVersion: 1, kind: "shutdown", sessionId: identity.sessionId, nonce: identity.nonce,
      messageId: nextMessageId(), requestId: shutdownRequestId, body: {},
    }
    const bytes = encodeControlEnvelope(shutdown)
    const forcing = await (async (): Promise<null | { reason: string }> => {
      if (bytes instanceof ProtocolError) {
        console.warn("host-supervisor: shutdown encode failed, forcing:", bytes.message)
        requestTable.supersede(shutdownRequestId, "shutdown encode failed")
        return { reason: `forced: shutdown encode failed [${bytes.code}]` }
      }
      const sent = await writeFramed(activeChild, bytes)
      if (sent instanceof SupervisorError) {
        console.warn("host-supervisor: shutdown write failed, forcing:", sent.message)
        requestTable.supersede(shutdownRequestId, "shutdown write failed")
        return { reason: `forced: shutdown write failed [${sent.code}]` }
      }
      const ack = await raceShutdownAck(ackPromise)
      if (ack instanceof Error) {
        const code = ack instanceof SupervisorError || ack instanceof ProtocolError ? ack.code : "UNKNOWN"
        console.warn("host-supervisor: no shutdown-ack, forcing:", ack.message)
        return { reason: `forced: no shutdown-ack [${code}]` }
      }
      activeChild.stdin.end()
      return null
    })()

    // teardown() reaps (kill iff forced) + closes the broker + clears the table +
    // stops the watchdog + drains stderr + returns inbound. The ack was already
    // routed by the pump (or timed out via raceShutdownAck), so clearing here is safe.
    await teardown(forcing !== null)
    await pumpTask
    phase = "stopped"
    return {
      phase: "stopped",
      forced: forcing !== null,
      exitCode: activeChild.exitCode,
      signalCode: activeChild.signalCode,
      reason: forcing?.reason ?? "graceful shutdown",
    }
  }

  // The §9 1 s shutdown-ack deadline as a dedicated timer racing the request table's
  // pump-routed ack. On timeout the table entry is left for clear() to settle.
  async function raceShutdownAck(ackPromise: Promise<ControlEnvelope | ProtocolError | SupervisorError>): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    let settleTimeout!: (error: SupervisorError) => void
    const timeout = new Promise<SupervisorError>((resolve) => { settleTimeout = resolve })
    const timer = deps.clock.setTimer(SHUTDOWN_ACK_TIMEOUT_MS, () =>
      settleTimeout(new SupervisorError({ code: "SHUTDOWN_TIMEOUT", reason: "no shutdown-ack within 1s" })),
    )
    const winner = await Promise.race([ackPromise, timeout])
    timer.cancel()
    return winner
  }

  return {
    identity,
    get phase() {
      return phase
    },
    start,
    stop,
    frames: broker.frames,
    resize,
    setMode,
    ping,
  }
}

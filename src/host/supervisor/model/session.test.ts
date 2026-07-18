import { describe, expect, test } from "bun:test"
import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol"
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  RuntimeDeclarationBundleV1,
} from "../../protocol"
import type { HostSessionSpec } from "../../types"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import {
  createScriptedChild,
  frameControl,
  frameFrame,
  frameHostHello,
} from "./scripted-child"
import type { ScriptedChild } from "./scripted-child"
import { readInbound } from "./transport"
import { createHostSession } from "./session"
import type { HostSessionDeps } from "../types"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
}
const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dash",
  sourcePath: "/scratch/page.tsx",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
}

/**
 * A responding fake host: decodes each supervisor write and emits the scripted
 * reply, so the supervisor's real drive loop runs end-to-end. Reads the
 * supervisor's minted sessionId/nonce off the client.hello it receives.
 */
function respondingChild(options?: { skipReady?: boolean; skipHello?: boolean; badAckIdentity?: boolean }): ScriptedChild {
  const child = createScriptedChild()
  let id: { sessionId: string; nonce: string } | null = null
  let messageId = 1n
  const nextId = () => {
    const value = messageId.toString()
    messageId += 1n
    return value
  }
  // decode writes through the shared inbound reader over a per-write mini stream
  child.onWrite = (bytes) => {
    void decodeWrite(bytes)
  }
  async function decodeWrite(bytes: Uint8Array) {
    // reuse readInbound over a throwaway child carrying just these bytes
    const carrier = createScriptedChild()
    carrier.emit(bytes)
    carrier.endStdout()
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return
      if (message.messageClass === "control" && id === null) {
        // it's the client.hello — parse identity from raw JSON
        const parsed = JSON.parse(new TextDecoder().decode(message.payload)) as { sessionId: string; nonce: string; kind: string }
        if (parsed.kind === "client.hello") {
          id = { sessionId: parsed.sessionId, nonce: parsed.nonce }
          if (options?.skipHello) return
          const hostHello: HostHelloV1 = {
            framingVersion: 1,
            kind: "host.hello",
            sessionId: id.sessionId,
            nonce: id.nonce,
            selectedFramingVersion: 1,
            selectedProtocolVersion: 1,
            runtimeDeclaration,
            limits: PROTOCOL_HARD_LIMITS,
          }
          const framed = frameHostHello(hostHello)
          if (!(framed instanceof ProtocolError)) child.emit(framed)
          return
        }
      }
      if (message.messageClass === "control" && id !== null) {
        const env = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope
        if (env.kind === "mount" && !options?.skipReady) {
          const ready: ControlEnvelope = {
            protocolVersion: 1,
            kind: "ready",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { size: { w: 80, h: 24 }, interactionMode: "static" },
          }
          const readyFramed = frameControl(ready)
          if (!(readyFramed instanceof ProtocolError)) child.emit(readyFramed)
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
          }
          const frameFramed = frameFrame(frame)
          if (!(frameFramed instanceof ProtocolError)) child.emit(frameFramed)
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
          }
          const framed = frameControl(ack)
          if (!(framed instanceof ProtocolError)) child.emit(framed)
          child.simulateExit({ code: 0 })
        }
      }
    }
  }
  return child
}

function deps(child: ScriptedChild, clock = createManualClock()): { deps: HostSessionDeps; clock: typeof clock } {
  return {
    clock,
    deps: {
      spawn: () => child,
      command: { cmd: ["_host", "--stdio"] },
      clock,
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    },
  }
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
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

describe("createHostSession lifecycle", () => {
  test("spawns, negotiates, mounts, and reaches ready with the first frame", async () => {
    const child = respondingChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const outcome = await session.start()
    expect(outcome).not.toBeInstanceOf(ProtocolError)
    expect(outcome).not.toBeInstanceOf(SupervisorError)
    if (outcome instanceof Error) throw outcome
    expect(session.phase).toBe("ready")
    expect(outcome.ready.kind).toBe("ready")
    expect(outcome.firstFrame?.frameSeq).toBe("1") // the frame that arrives AFTER ready
    expect(outcome.negotiatedLimits).toEqual(PROTOCOL_HARD_LIMITS)

    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(false)
    expect(stop.exitCode).toBe(0)
    expect(session.phase).toBe("stopped")
  })

  test("times out to HANDSHAKE_TIMEOUT when host.hello never arrives", async () => {
    const child = respondingChild({ skipHello: true })
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const startPromise = session.start()
    // Block until start() is parked in "negotiating" with the 3s handshake timer armed.
    await waitUntil(() => session.phase === "negotiating" && clock.pending() >= 1, "handshake timer armed")
    clock.advance(3_000)
    const outcome = await startPromise
    expect(outcome).toBeInstanceOf(SupervisorError)
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("HANDSHAKE_TIMEOUT")
    expect(session.phase).toBe("failed")
    expect(child.signalCode).toBe("SIGTERM") // killed + reaped on the failure path
  })

  test("times out to MOUNT_TIMEOUT when ready never arrives", async () => {
    const child = respondingChild({ skipReady: true })
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const startPromise = session.start()
    // Handshake completes under real microtasks; block until "mounting" + the 10s timer is armed.
    await waitUntil(() => session.phase === "mounting" && clock.pending() >= 1, "mount timer armed")
    clock.advance(10_000)
    const outcome = await startPromise
    expect(outcome).toBeInstanceOf(SupervisorError)
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("MOUNT_TIMEOUT")
    expect(session.phase).toBe("failed")
  })

  test("force-kills and still reaches stopped when shutdown-ack never arrives", async () => {
    const child = respondingChild() // reaches ready normally...
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    child.onWrite = () => {} // ...then stops acking shutdown
    const stopPromise = session.stop()
    // Block until the 1s shutdown-ack timer is armed, then trip it. The forced kill
    // resolves `exited` under a microtask, so the 1s reap timer never needs advancing.
    await waitUntil(() => clock.pending() >= 3, "shutdown-ack timer armed")
    clock.advance(1_000)
    const stop = await stopPromise
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(true)
    expect(stop.signalCode).toBe("SIGTERM")
    expect(session.phase).toBe("stopped")
  })

  test("rejects a shutdown-ack whose identity echo is wrong and forces the stop", async () => {
    // The child returns a shutdown-ack with the correct responseTo but a WRONG
    // nonce. §5.2/§10.1: every decoded inbound envelope must echo the incarnation's
    // sessionId AND nonce — a mismatch is fatal. The supervisor must NOT accept the
    // forged ack as a graceful shutdown of THIS incarnation; it must force.
    const child = respondingChild({ badAckIdentity: true })
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started

    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(true) // forged-identity ack was rejected, not accepted
    expect(stop.reason).toContain("MALFORMED_PROTOCOL")
    expect(session.phase).toBe("stopped")
  })
})

// --- 2D-2: post-ready pump + stop-via-request-table ---

/**
 * Extends the responding fake host with post-ready behavior: it answers `ping`
 * with `pong`, `resize`/`set-mode` with a correlated echo, and can emit a data
 * frame / heartbeat on demand. Built on the same onWrite decode loop.
 */
function livePreviewChild(): ScriptedChild {
  const child = createScriptedChild()
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
      if (raw.kind === "ping") {
        send({ protocolVersion: 1, kind: "pong", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: {} })
        return
      }
      if (raw.kind === "resize") {
        send({ protocolVersion: 1, kind: "resize", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: raw.body.size! } })
        return
      }
      if (raw.kind === "set-mode") {
        send({ protocolVersion: 1, kind: "set-mode", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { interactionMode: raw.body.interactionMode! } })
        return
      }
      if (raw.kind === "shutdown") {
        send({ protocolVersion: 1, kind: "shutdown-ack", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { ok: true } })
        child.simulateExit({ code: 0 })
        return
      }
    }
  }
  // Helper: emit a post-ready frame / heartbeat once identity is known.
  ;(child as ScriptedChild & { emitFrame(seq: string): void; emitHeartbeat(): void }).emitFrame = (seq) => {
    if (id === null) return
    const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: seq, width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
    const framed = frameFrame(frame)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  ;(child as ScriptedChild & { emitFrame(seq: string): void; emitHeartbeat(): void }).emitHeartbeat = () => {
    if (id === null) return
    send({ protocolVersion: 1, kind: "heartbeat", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), body: {} })
  }
  return child
}

describe("createHostSession post-ready pump (2D-2)", () => {
  test("the firstFrame reaches the broker and post-ready frames stream through it", async () => {
    const child = livePreviewChild() as ScriptedChild & { emitFrame(seq: string): void }
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started

    const iterator = session.frames[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.frameSeq).toBe("1") // the captured firstFrame published at pump start

    child.emitFrame("2")
    const second = await iterator.next()
    expect(second.value?.frameSeq).toBe("2")

    await session.stop()
  })

  test("a correlated ping resolves through the request table", async () => {
    const child = livePreviewChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    const pong = await session.ping()
    expect(pong).not.toBeInstanceOf(SupervisorError)
    if (pong instanceof Error) throw pong
    expect(pong.kind).toBe("pong")
    await session.stop()
  })

  test("a heartbeat feeds the watchdog; 5 s of silence tears down to failed with HEARTBEAT_TIMEOUT", async () => {
    const child = livePreviewChild() as ScriptedChild & { emitHeartbeat(): void }
    const clock = createManualClock()
    const fatals: (SupervisorError | ProtocolError)[] = []
    const base = deps(child, clock).deps
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) })
    const started = await session.start()
    if (started instanceof Error) throw started
    // Arm the 5 s heartbeat deadline (the pump called watchdog.start() at ready).
    await waitUntil(() => clock.pending() >= 1, "heartbeat timer armed")
    clock.advance(5_000)
    // `phase` flips to "failed" SYNCHRONOUSLY inside failFromReady, but onFatal is
    // invoked at the END of the async finalizeFatalTeardown — so wait on `fatals`,
    // NOT on `phase`, or the assertion runs before onFatal fires (deterministic red).
    await waitUntil(() => fatals.length === 1, "onFatal fired after teardown")
    expect(session.phase).toBe("failed")
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("HEARTBEAT_TIMEOUT")
  })

  test("stop() correlates shutdown-ack through the request table (graceful path still works)", async () => {
    const child = livePreviewChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(false)
    expect(stop.exitCode).toBe(0)
  })

  test("a post-ready frame with a wrong nonce is a fatal MALFORMED_PROTOCOL, not a silent drop (§10.1/§5.3/§12)", async () => {
    const child = livePreviewChild()
    const clock = createManualClock()
    const fatals: (SupervisorError | ProtocolError)[] = []
    const base = deps(child, clock).deps
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) })
    const started = await session.start()
    if (started instanceof Error) throw started
    // The live child (correct identity) emits a frame whose nonce does NOT match this
    // incarnation. With ONE decoder there is no cross-nonce noise — it is a real §10.1
    // violation the pump must fatal, not drop. (A backwards frameSeq is symmetric: the
    // broker returns "stale" on an identity-valid frame → onPumpFatal MALFORMED_PROTOCOL.)
    const forged: FrameEnvelope = {
      protocolVersion: 1, kind: "frame", sessionId: session.identity.sessionId, nonce: "f".repeat(32),
      sourceHash: spec.sourceHash, frameSeq: "2", width: 80, height: 24, rows: Array.from({ length: 24 }, () => []),
    }
    const framed = frameFrame(forged)
    if (framed instanceof ProtocolError) throw framed
    child.emit(framed)
    await waitUntil(() => fatals.length === 1, "pump fataled on the wrong-nonce frame")
    expect(session.phase).toBe("failed")
    expect(fatals[0] instanceof ProtocolError && fatals[0].code).toBe("MALFORMED_PROTOCOL")
  })
})

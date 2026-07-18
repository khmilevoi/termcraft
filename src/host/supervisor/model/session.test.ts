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
function respondingChild(options?: { skipReady?: boolean; skipHello?: boolean }): ScriptedChild {
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
            nonce: id.nonce,
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
    await waitUntil(() => clock.pending() >= 1, "shutdown-ack timer armed")
    clock.advance(1_000)
    const stop = await stopPromise
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(true)
    expect(stop.signalCode).toBe("SIGTERM")
    expect(session.phase).toBe("stopped")
  })
})

/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"

import { createHeadlessRenderer, type RenderHandle } from "../../render"
import {
  decodeControlEnvelope,
  encodeClientHello,
  encodeControlEnvelope,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  type ClientHelloV1,
  type ControlEnvelope,
  type FrameEnvelope,
  type HostHelloV1,
  type PublicLimits,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import type { HostSessionDeps, OutboundMessage } from "../types"
import { createHostSession } from "./host-state-machine"

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
}

const SESSION_ID = "01920000-0000-7000-8000-000000000000"
const NONCE = "0123456789abcdef0123456789abcdef"

const clientHello = (over: Partial<ClientHelloV1> = {}): ClientHelloV1 => ({
  framingVersion: 1,
  kind: "client.hello",
  sessionId: SESSION_ID,
  nonce: NONCE,
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "dashboard",
  sourceHash: "a".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: RUNTIME_DECLARATION,
  limits: PROTOCOL_HARD_LIMITS,
  ...over,
})

interface Harness {
  readonly out: OutboundMessage[]
  readonly exits: { code: number; reason: string }[]
  readonly deps: HostSessionDeps
}

function harness(over: Partial<HostSessionDeps> = {}): Harness {
  const out: OutboundMessage[] = []
  const exits: { code: number; reason: string }[] = []
  const deps: HostSessionDeps = {
    runtimeDeclaration: RUNTIME_DECLARATION,
    limits: PROTOCOL_HARD_LIMITS,
    loadPage: async () => ({ meta: { kitApiVersion: 1, title: "t", minSize: { w: 4, h: 1 }, theme: "dark-default" }, component: () => null, sourceHash: "a".repeat(64) }),
    createRenderer: async () => { throw new Error("not used in this task") },
    now: () => 1000,
    send: (m) => out.push(m),
    requestExit: (r) => exits.push(r),
    ...over,
  }
  return { out, exits, deps }
}

// Encode a client.hello to the raw control payload the state machine decodes.
function helloPayload(hello: ClientHelloV1): Uint8Array {
  const framed = encodeClientHello(hello)
  if (framed instanceof Error) throw framed
  // encodeClientHello prepends the 8-byte frame header; the state machine
  // receives the PAYLOAD (the entry strips the header via FrameDecoder).
  return framed.slice(8)
}

describe("host session — handshake", () => {
  test("answers a valid client.hello with a host.hello echoing identity", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    await session.receiveControlPayload(helloPayload(clientHello()))

    expect(h.out).toHaveLength(1)
    const first = h.out[0]!
    expect(first.type).toBe("host-hello")
    const hello = (first as { payload: HostHelloV1 }).payload
    expect(hello.kind).toBe("host.hello")
    expect(hello.sessionId).toBe(SESSION_ID)
    expect(hello.nonce).toBe(NONCE)
    expect(hello.selectedFramingVersion).toBe(1)
    expect(hello.selectedProtocolVersion).toBe(1)
    expect(hello.runtimeDeclaration).toEqual(RUNTIME_DECLARATION)
  })

  test("negotiates limits to the per-field minimum of client and host", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    const stricter: PublicLimits = { ...PROTOCOL_HARD_LIMITS, maxFrameWidth: 100 }
    await session.receiveControlPayload(helloPayload(clientHello({ limits: stricter })))
    const hello = (h.out[0] as { payload: HostHelloV1 }).payload
    expect(hello.limits.maxFrameWidth).toBe(100)
    expect(hello.limits.controlPayloadBytes).toBe(PROTOCOL_HARD_LIMITS.controlPayloadBytes)
  })

  test("a malformed client.hello requests exit and emits no host.hello", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    await session.receiveControlPayload(new TextEncoder().encode("{ not json"))
    expect(h.out).toHaveLength(0)
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(1)
  })
})

let liveRenderer: RenderHandle | null = null
afterEach(() => {
  liveRenderer?.destroy()
  liveRenderer = null
})

const FixtureComponent = () => (
  <box>
    <text>mounted-ok</text>
  </box>
)

function mountEnvelope(over: Partial<ControlEnvelope["body"]> = {}, sessionId = SESSION_ID, nonce = NONCE): Uint8Array {
  const envelope: ControlEnvelope = {
    protocolVersion: 1,
    kind: "mount",
    sessionId,
    nonce,
    messageId: "1",
    requestId: "1",
    body: {
      sourcePath: "/unused/in/fake/loadPage.tsx",
      expectedSourceHash: "a".repeat(64),
      mode: "preview",
      interactionMode: "static",
      size: { w: 16, h: 3 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
      deterministic: true,
      ...over,
    },
  }
  const framed = encodeControlEnvelope(envelope)
  if (framed instanceof Error) throw framed
  return framed.slice(8)
}

async function handshaken(over: Partial<HostSessionDeps> = {}) {
  const h = harness({
    createRenderer: (size) => {
      return createHeadlessRenderer(size).then((r) => {
        liveRenderer = r
        return r
      })
    },
    loadPage: async () => ({
      meta: { kitApiVersion: 1, title: "Dashboard", minSize: { w: 16, h: 3 }, theme: "dark-default" },
      component: FixtureComponent,
      sourceHash: "a".repeat(64),
    }),
    ...over,
  })
  const session = createHostSession(h.deps)
  await session.receiveControlPayload(helloPayload(clientHello()))
  h.out.length = 0 // drop the host.hello
  return { h, session }
}

describe("host session — mount", () => {
  test("mount emits ready then the first frame, both under one identity", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope())

    expect(h.out).toHaveLength(2)
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload
    expect(ready.kind).toBe("ready")
    expect(ready.responseTo).toBe("1")
    expect(ready.sessionId).toBe(SESSION_ID)
    const readyBody = ready.body as unknown as {
      meta: { title: string }
      size: { w: number; h: number }
      interactionMode: string
      frameIdentity: { frameSeq: string; sourceHash: string }
    }
    expect(readyBody.meta.title).toBe("Dashboard")
    expect(readyBody.size).toEqual({ w: 16, h: 3 })
    expect(readyBody.interactionMode).toBe("static")
    expect(readyBody.frameIdentity.frameSeq).toBe("1")

    const frame = (h.out[1] as { payload: FrameEnvelope }).payload
    expect(frame.kind).toBe("frame")
    expect(frame.frameSeq).toBe("1")
    expect(frame.width).toBe(16)
    expect(frame.sourceHash).toBe("a".repeat(64))
    expect((frame.rows[0] ?? []).map((r) => r.text).join("")).toContain("mounted-ok")
  })

  test("preview mount stays alive (no exit)", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope())
    expect(h.exits).toHaveLength(0)
  })

  test("smoke mount emits ready+frame then exits 0 (one-shot)", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope({ mode: "smoke" }))
    expect(h.out).toHaveLength(2)
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(0)
  })

  test("a non-preview mount forces effective static even if interactive requested", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(
      mountEnvelope({ mode: "historical", interactionMode: "interactive" }),
    )
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload
    expect((ready.body as unknown as { interactionMode: string }).interactionMode).toBe("static")
  })

  test("a loadPage failure emits a typed error and exits", async () => {
    const { h, session } = await handshaken({
      loadPage: async () => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "source hash mismatch" }),
    })
    await session.receiveControlPayload(mountEnvelope())
    const errorMsg = h.out.find((m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error")
    expect(errorMsg).toBeDefined()
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(1)
  })

  test("an inbound envelope with the wrong nonce is fatal", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope({}, SESSION_ID, "f".repeat(32)))
    expect(h.exits).toHaveLength(1)
  })
})

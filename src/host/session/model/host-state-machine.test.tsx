/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test"

import {
  encodeClientHello,
  PROTOCOL_HARD_LIMITS,
  type ClientHelloV1,
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

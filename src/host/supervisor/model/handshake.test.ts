import { describe, expect, test } from "bun:test"
import { ProtocolError, PROTOCOL_HARD_LIMITS } from "../../protocol"
import type { HostHelloV1, PublicLimits, RuntimeDeclarationBundleV1 } from "../../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../../types"
import { buildClientHello, verifyHostHello } from "./handshake"
import type { HandshakeInputs } from "./handshake"

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
const identity: HostSessionIdentity = {
  mode: "preview",
  pageSlug: "dash",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  sessionId: "01920000-0000-7000-8000-000000000000",
  nonce: "b".repeat(32),
}
const inputs: HandshakeInputs = {
  spec,
  identity,
  runtimeDeclaration,
  offeredLimits: PROTOCOL_HARD_LIMITS,
}
function hostHello(overrides: Partial<HostHelloV1> = {}): HostHelloV1 {
  return {
    framingVersion: 1,
    kind: "host.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    selectedFramingVersion: 1,
    selectedProtocolVersion: 1,
    runtimeDeclaration,
    limits: PROTOCOL_HARD_LIMITS,
    ...overrides,
  }
}

describe("buildClientHello", () => {
  test("assembles a valid ClientHelloV1 from the spec + minted identity", () => {
    const hello = buildClientHello(inputs)
    expect(hello.kind).toBe("client.hello")
    expect(hello.sessionId).toBe(identity.sessionId)
    expect(hello.nonce).toBe(identity.nonce)
    expect(hello.mode).toBe("preview")
    expect(hello.pageSlug).toBe("dash")
    expect(hello.sourceHash).toBe("a".repeat(64))
    expect(hello.sourceKitApiVersion).toBe(1)
    expect(hello.offeredFramingVersions).toEqual([1])
    expect(hello.offeredProtocolVersions).toEqual([1])
    expect(hello.limits).toEqual(PROTOCOL_HARD_LIMITS)
  })
})

describe("verifyHostHello", () => {
  test("accepts a valid echo and negotiates the per-field min limits", () => {
    const stricter: PublicLimits = {
      controlPayloadBytes: 1000,
      framePayloadBytes: 2000,
      maxFrameWidth: 100,
      maxFrameHeight: 100,
      maxFrameCells: 5000,
    }
    const result = verifyHostHello(hostHello({ limits: stricter }), inputs)
    expect(result).not.toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) throw result
    expect(result.negotiatedLimits).toEqual(stricter)
  })

  test("rejects a sessionId echo mismatch with MALFORMED_PROTOCOL", () => {
    const result = verifyHostHello(hostHello({ sessionId: "different" }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })

  test("rejects a nonce echo mismatch with MALFORMED_PROTOCOL", () => {
    const result = verifyHostHello(hostHello({ nonce: "c".repeat(32) }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })

  test("rejects a runtime declaration disagreement with RUNTIME_INTEGRITY_MISMATCH", () => {
    const result = verifyHostHello(
      hostHello({ runtimeDeclaration: { ...runtimeDeclaration, publicCapabilityIds: ["extra"] } }),
      inputs,
    )
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("RUNTIME_INTEGRITY_MISMATCH")
  })

  test("rejects an unsupported source kit API with KIT_API_MISMATCH", () => {
    const declV2 = { ...runtimeDeclaration, currentKitApiVersion: 2, supportedKitApiVersions: [2] }
    const result = verifyHostHello(
      hostHello({ runtimeDeclaration: declV2 }),
      { ...inputs, runtimeDeclaration: declV2, spec: { ...spec, kitApiVersion: 1 }, identity: { ...identity, kitApiVersion: 1 } },
    )
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("KIT_API_MISMATCH")
  })

  test("rejects child limits larger than offered with MALFORMED_PROTOCOL", () => {
    const tooBig: PublicLimits = { ...PROTOCOL_HARD_LIMITS, maxFrameCells: PROTOCOL_HARD_LIMITS.maxFrameCells + 1 }
    const result = verifyHostHello(hostHello({ limits: tooBig }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })
})

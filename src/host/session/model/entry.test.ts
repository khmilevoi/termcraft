import { describe, expect, test } from "bun:test"

import { FrameDecoder, type WireFrame } from "infrastructure/framing"
import {
  decodeHostHello,
  encodeClientHello,
  PROTOCOL_HARD_LIMITS,
  type ClientHelloV1,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import { parseHostArgs, runHostStdio } from "./entry"

describe("parseHostArgs", () => {
  test("accepts a compiled-binary _host --stdio argv", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host", "--stdio"])).toBe(true)
  })
  test("accepts a bun run _host --stdio argv", () => {
    expect(parseHostArgs(["bun", "/src/main.ts", "_host", "--stdio"])).toBe(true)
  })
  test("rejects a normal launch", () => {
    expect(parseHostArgs(["C:/termcraft.exe"])).toBe(false)
  })
  test("rejects _host without --stdio", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host"])).toBe(false)
  })
})

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
}
const SESSION_ID = "01920000-0000-7000-8000-000000000000"
const NONCE = "0123456789abcdef0123456789abcdef"

const clientHelloFrame = (): Uint8Array => {
  const hello: ClientHelloV1 = {
    framingVersion: 1, kind: "client.hello", sessionId: SESSION_ID, nonce: NONCE,
    offeredFramingVersions: [1], offeredProtocolVersions: [1], mode: "preview",
    pageSlug: "dashboard", sourceHash: "a".repeat(64), sourceKitApiVersion: 1,
    runtimeDeclaration: RUNTIME_DECLARATION, limits: PROTOCOL_HARD_LIMITS,
  }
  const framed = encodeClientHello(hello)
  if (framed instanceof Error) throw framed
  return framed
}

describe("runHostStdio (in-memory transport)", () => {
  test("negotiates a host.hello from a client.hello fed as framed bytes", async () => {
    const output: Uint8Array[] = []
    const exits: number[] = []
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>()

    async function* input() {
      yield clientHelloFrame()
      // Give the host a moment to answer, then close the input to end the run.
      await new Promise((r) => setTimeout(r, 50))
    }

    await runHostStdio({
      argv: ["exe", "_host", "--stdio"],
      input: input(),
      output: (bytes) => output.push(bytes),
      now: () => 1000,
      exit: (code) => { exits.push(code); resolveExit() },
      deps: {
        runtimeDeclaration: RUNTIME_DECLARATION,
        limits: PROTOCOL_HARD_LIMITS,
        createRenderer: async () => { throw new Error("no mount in this test") },
      },
    })

    // Decode the host's framed output.
    const decoder = new FrameDecoder()
    const frames: WireFrame[] = []
    for (const chunk of output) {
      const fed = decoder.feed(chunk)
      if (fed instanceof Error) throw fed
      frames.push(...fed)
    }
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const hostHello = decodeHostHello(frames[0]!.payload)
    if (hostHello instanceof Error) throw hostHello
    expect(hostHello.kind).toBe("host.hello")
    expect(hostHello.sessionId).toBe(SESSION_ID)
  })
})

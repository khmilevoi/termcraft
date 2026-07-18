import { describe, expect, test } from "bun:test"
import { FrameDecoder } from "../../../infrastructure/framing"
import { decodeHostHello, ProtocolError } from "../../protocol"
import { createScriptedChild, frameHostHello } from "./scripted-child"

describe("createScriptedChild", () => {
  test("captures writes and lets the script emit framed stdout the reader decodes", async () => {
    const child = createScriptedChild()
    child.stdin.write(new Uint8Array([1, 2, 3]))
    expect(child.written.length).toBe(1)
    expect(Array.from(child.written[0]!)).toEqual([1, 2, 3])

    const hello = frameHostHello({
      framingVersion: 1,
      kind: "host.hello",
      sessionId: "s1",
      nonce: "0".repeat(32),
      selectedFramingVersion: 1,
      selectedProtocolVersion: 1,
      runtimeDeclaration: { module: "@termcraft/runtime", currentKitApiVersion: 1, supportedKitApiVersions: [1], publicCapabilityIds: [] },
      limits: { controlPayloadBytes: 1000, framePayloadBytes: 1000, maxFrameWidth: 100, maxFrameHeight: 100, maxFrameCells: 1000 },
    })
    expect(hello).not.toBeInstanceOf(ProtocolError)
    if (hello instanceof ProtocolError) throw hello

    const decoder = new FrameDecoder()
    const collected: string[] = []
    const reading = (async () => {
      for await (const chunk of child.stdout) {
        const frames = decoder.feed(chunk)
        if (frames instanceof Error) throw frames
        for (const frame of frames) {
          const decoded = decodeHostHello(frame.payload)
          if (!(decoded instanceof ProtocolError)) collected.push(decoded.sessionId)
        }
      }
    })()
    child.emit(hello)
    child.endStdout()
    await reading
    expect(collected).toEqual(["s1"])
  })

  test("simulateExit resolves exited with a clean code; kill sets signalCode", async () => {
    const clean = createScriptedChild()
    clean.simulateExit({ code: 0 })
    expect(await clean.exited).toBe(0)
    expect(clean.exitCode).toBe(0)
    expect(clean.signalCode).toBeNull()

    const killed = createScriptedChild()
    killed.kill()
    expect(await killed.exited).toBe(143)
    expect(killed.exitCode).toBeNull()
    expect(killed.signalCode).toBe("SIGTERM")
  })
})

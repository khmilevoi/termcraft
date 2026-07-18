import { describe, expect, test } from "bun:test"
import { ProtocolError } from "../../protocol"
import { SupervisorError } from "./errors"
import { createScriptedChild, frameRawControl } from "./scripted-child"
import { createStderrDrain, readInbound, writeFramed } from "./transport"
import type { InboundMessage } from "./transport"

describe("writeFramed", () => {
  test("awaits the possibly-async write + flush and returns null on success", async () => {
    const child = createScriptedChild()
    const result = await writeFramed(child, new Uint8Array([9, 9]))
    expect(result).toBeNull()
    expect(Array.from(child.written[0]!)).toEqual([9, 9])
  })
})

describe("readInbound", () => {
  test("yields decoded control/data messages across fragmented chunks", async () => {
    const child = createScriptedChild()
    const framed = frameRawControl(new TextEncoder().encode('{"k":1}'))
    // deliver the frame split byte-by-byte (fragmentation is normal — Spike E)
    for (const byte of framed) child.emit(new Uint8Array([byte]))
    child.endStdout()

    const messages: InboundMessage[] = []
    for await (const message of readInbound(child)) {
      if (message instanceof Error) throw message
      messages.push(message)
    }
    expect(messages.length).toBe(1)
    expect(messages[0]!.messageClass).toBe("control")
    expect(new TextDecoder().decode(messages[0]!.payload)).toBe('{"k":1}')
  })

  test("yields a ProtocolError (MALFORMED_PROTOCOL) on a framing violation and stops", async () => {
    const child = createScriptedChild()
    // payload length 0 is a fatal framing error
    child.emit(new Uint8Array([0, 0, 0, 0, 1, 1, 0, 0]))
    child.endStdout()
    const out: (ProtocolError | SupervisorError | InboundMessage)[] = []
    for await (const message of readInbound(child)) out.push(message)
    expect(out.length).toBe(1)
    expect(out[0]).toBeInstanceOf(ProtocolError)
    if (out[0] instanceof ProtocolError) expect(out[0].code).toBe("MALFORMED_PROTOCOL")
  })
})

describe("createStderrDrain", () => {
  test("retains only the bounded 64 KiB tail and counts discarded bytes", async () => {
    const child = createScriptedChild()
    const drain = createStderrDrain(child)
    const chunk = new Uint8Array(50_000).fill(65) // 'A'
    child.emitStderr(chunk)
    child.emitStderr(chunk) // 100_000 total > 65_536
    child.simulateExit({ code: 0 })
    await child.exited
    await drain.settled // drain has consumed the closed stream
    expect(drain.tail().length).toBe(65_536)
    expect(drain.discarded()).toBe(100_000 - 65_536)
    drain.stop()
  })
})

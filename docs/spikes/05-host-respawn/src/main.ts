import { spawn } from "node:child_process"

// A frame is a 4-byte big-endian length followed by that many bytes of JSON.
function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function makeFrameReader(onFrame: (obj: unknown) => void) {
  let buf = Buffer.alloc(0)
  let dataEvents = 0
  let frameCount = 0
  return {
    onData: (chunk: Buffer) => {
      dataEvents++
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (buf.length < 4) return
        const len = buf.readUInt32BE(0)
        if (buf.length < 4 + len) return
        const body = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        frameCount++
        onFrame(JSON.parse(body.toString("utf8")))
      }
    },
    stats: () => ({ dataEvents, frameCount }),
  }
}

const CANARY = "a\nb\r\nc dÿ"

// Build a LoadFrame whose payload is exactly `payload`, padded with a separate
// `pad` field of ASCII filler until the 4-byte big-endian length header's low
// byte equals `forceHeaderByte`. This targets the actual corruption-risk byte
// (a raw 0x0A/0x0D in the BINARY header) rather than relying on JSON string
// content, which JSON.stringify always escapes (so a literal \n never appears
// as a raw byte inside the JSON body itself).
function buildLoadFrame(id: string, payload: string, forceHeaderByte: number) {
  for (let padLen = 0; padLen < 512; padLen++) {
    const obj = { type: "LoadFrame", id, payload, pad: "p".repeat(padLen) }
    const body = Buffer.from(JSON.stringify(obj), "utf8")
    if (body.length % 256 === forceHeaderByte) {
      return { frame: encodeFrame(obj), bodyLength: body.length, padLen }
    }
  }
  throw new Error(`could not tune header byte 0x${forceHeaderByte.toString(16)} for ${id}`)
}

// ---- host role ----
if (process.argv[2] === "_host" && process.argv[3] === "--stdio") {
  const reader = makeFrameReader((msg: any) => {
    if (msg.type === "ClientHelloV1") {
      process.stdout.write(
        encodeFrame({
          type: "HostHelloV1",
          framingVersion: 1,
          echoed: msg,
          // A payload with bytes that Windows text-mode translation would mangle.
          canary: CANARY,
        }),
      )
      return
    }
    if (msg.type === "LoadFrame") {
      process.stdout.write(
        encodeFrame({
          type: "LoadFrameEcho",
          id: msg.id,
          length: msg.payload.length,
          payload: msg.payload,
        }),
      )
      return
    }
  })
  process.stdin.on("data", reader.onData)
  process.stdin.resume()
} else {
  // ---- supervisor role ----
  const selfPath = process.execPath
  const t0 = performance.now()
  const child = spawn(selfPath, ["_host", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  })
  let stderr = ""
  child.stderr.on("data", (c) => (stderr += c.toString()))

  const bigPayload = CANARY + "x".repeat(256 * 1024 - CANARY.length)
  const smallPayload = "Z"
  const bigLoad = buildLoadFrame("big-256kib", bigPayload, 0x0a)
  const smallLoad = buildLoadFrame("small-1b", smallPayload, 0x0d)

  let phase: "hello" | "load" = "hello"
  let negotiationMs = -1
  let helloReply: unknown = null
  let canaryIntact = false
  const loadResults: Record<string, { ok: boolean; length: number; expectedLength: number }> = {}

  function finish() {
    console.log(
      JSON.stringify(
        {
          ok: true,
          selfPath,
          argv0: process.argv[0],
          negotiationMs,
          reply: helloReply,
          canaryIntact,
          loadTest: {
            big: {
              targetBytes: 256 * 1024,
              headerLowByteForced: "0x0a",
              bodyLength: bigLoad.bodyLength,
              headerBytes: (() => {
                const h = Buffer.alloc(4)
                h.writeUInt32BE(bigLoad.bodyLength, 0)
                return [...h].map((b) => "0x" + b.toString(16).padStart(2, "0"))
              })(),
              ...loadResults["big-256kib"],
            },
            small: {
              targetBytes: 1,
              headerLowByteForced: "0x0d",
              bodyLength: smallLoad.bodyLength,
              headerBytes: (() => {
                const h = Buffer.alloc(4)
                h.writeUInt32BE(smallLoad.bodyLength, 0)
                return [...h].map((b) => "0x" + b.toString(16).padStart(2, "0"))
              })(),
              ...loadResults["small-1b"],
            },
          },
          stdoutDataEvents: reader.stats().dataEvents,
          stdoutFrameCount: reader.stats().frameCount,
          stderr,
        },
        null,
        2,
      ),
    )
    child.kill()
    process.exit(0)
  }

  const reader = makeFrameReader((msg: any) => {
    if (phase === "hello" && msg.type === "HostHelloV1") {
      negotiationMs = performance.now() - t0
      helloReply = msg
      canaryIntact = msg.canary === CANARY
      phase = "load"
      // Send both load frames back-to-back, in two separate writes, with no
      // delay, to see whether Bun/Windows ever splits or coalesces them.
      child.stdin.write(bigLoad.frame)
      child.stdin.write(smallLoad.frame)
      return
    }
    if (msg.type === "LoadFrameEcho") {
      const expected = msg.id === "big-256kib" ? bigPayload : smallPayload
      loadResults[msg.id] = {
        ok: msg.payload === expected,
        length: msg.length,
        expectedLength: expected.length,
      }
      if (Object.keys(loadResults).length === 2) finish()
      return
    }
  })
  child.stdout.on("data", reader.onData)

  child.on("error", (e) => {
    console.log(JSON.stringify({ ok: false, selfPath, name: e.name, message: e.message }, null, 2))
    process.exit(1)
  })
  child.stdin.write(encodeFrame({ type: "ClientHelloV1", framingVersion: 1 }))
  setTimeout(() => {
    console.log(
      JSON.stringify(
        {
          ok: false,
          selfPath,
          reason: "3s negotiation deadline",
          phase,
          negotiationMs,
          loadResults,
          stderr,
        },
        null,
        2,
      ),
    )
    child.kill()
    process.exit(1)
  }, 3000)
}

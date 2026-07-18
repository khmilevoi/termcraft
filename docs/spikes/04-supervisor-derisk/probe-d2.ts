// D2 — kill + reap timing and confirmation.
// Measures proc.kill() -> await proc.exited latency, whether proc.exited resolves
// with a code on the forced path, whether a second kill after exit is safe, and
// whether writing to a dead child's stdin throws (and is instanceof Error).
import { FrameDecoder } from "../../../src/infrastructure/framing"
import {
  decodeHostHello,
  encodeClientHello,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
} from "../../../src/host/protocol"
import type { ClientHelloV1, RuntimeDeclarationBundleV1 } from "../../../src/host/protocol"
import { CURRENT_KIT_API_VERSION } from "../../../src/runtime"

const log = (tag: string, value: unknown) =>
  console.log(`D2:${tag}`, typeof value === "string" ? value : JSON.stringify(value))

const hardStop = setTimeout(() => {
  console.log("D2:TIMEOUT hard 20s")
  process.exit(9)
}, 20_000)
hardStop.unref()

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
}
const hello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId: "0192bb00bb00bb00bb00bb00bb",
  nonce: "1".repeat(32),
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "probe",
  sourceHash: "0".repeat(64),
  sourceKitApiVersion: CURRENT_KIT_API_VERSION,
  runtimeDeclaration,
  limits: PROTOCOL_HARD_LIMITS,
}

const wrapperPath = `${import.meta.dir}/host-wrapper.ts`
const proc = Bun.spawn({
  cmd: [process.execPath, wrapperPath, "_host", "--stdio"],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

// Handshake so the child is live (heartbeat interval running) before we kill it —
// this is the realistic "kill a running incarnation" case.
const framed = encodeClientHello(hello)
if (framed instanceof ProtocolError) {
  log("encode.fail", String(framed.reason))
  process.exit(1)
}
proc.stdin.write(framed)
proc.stdin.flush()

const decoder = new FrameDecoder()
let live = false
const reader = (async () => {
  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    const frames = decoder.feed(chunk)
    if (frames instanceof Error) return
    for (const frame of frames) {
      if (frame.messageClass === "control" && !live) {
        const decoded = decodeHostHello(frame.payload)
        if (!(decoded instanceof ProtocolError)) live = true
      }
    }
    if (live) return
  }
})()
await Promise.race([reader, new Promise((r) => setTimeout(r, 4_000))])
log("handshake", { live })

// --- kill + reap timing ---
const killStart = Bun.nanoseconds()
proc.kill() // default signal
const killCode = await proc.exited
const killMs = Math.round((Bun.nanoseconds() - killStart) / 1e6)
log("kill.reap", {
  killMs,
  exitedResolvedWith: killCode,
  exitCode: proc.exitCode,
  signalCode: proc.signalCode,
})

// --- second kill after exit: safe? ---
const secondKill = (() => {
  try {
    proc.kill()
    return "no-throw"
  } catch (e) {
    return { threw: true, isError: e instanceof Error, message: String((e as Error)?.message ?? e) }
  }
})()
log("second.kill", secondKill)

// --- await exited again (idempotent?) ---
const secondExited = await proc.exited.then((c) => ({ code: c })).catch((e) => ({ rejected: String(e) }))
log("second.exited", secondExited)

// --- write to a dead child's stdin: throw? instanceof Error? ---
const deadWrite = await (async () => {
  try {
    const r = proc.stdin.write(framed)
    proc.stdin.flush()
    const awaited = typeof (r as { then?: unknown })?.then === "function" ? await (r as Promise<unknown>).catch((e) => ({ writeRejected: String(e) })) : r
    return { sync: "no-throw", awaited: typeof awaited === "number" ? awaited : String(awaited) }
  } catch (e) {
    return { threw: true, isError: e instanceof Error, ctor: (e as { constructor?: { name?: string } })?.constructor?.name ?? null, message: String((e as Error)?.message ?? e) }
  }
})()
log("dead.stdin.write", deadWrite)

clearTimeout(hardStop)
console.log("D2:DONE")

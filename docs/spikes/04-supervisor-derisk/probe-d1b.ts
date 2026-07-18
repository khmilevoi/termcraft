// D1b — graceful shutdown round-trip (the supervisor's normal stop path, not EOF).
// Handshake, then send a `shutdown` control request; expect a `shutdown-ack`
// response correlated by responseTo, then a clean exit 0. Confirms the §9
// shutdown->ack->reap path the 2D-1 graceful-stop timeout drives.
import { FrameDecoder } from "../../../src/infrastructure/framing"
import {
  decodeControlEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
} from "../../../src/host/protocol"
import type {
  ClientHelloV1,
  ControlEnvelope,
  RuntimeDeclarationBundleV1,
} from "../../../src/host/protocol"
import { CURRENT_KIT_API_VERSION } from "../../../src/runtime"

const log = (tag: string, value: unknown) =>
  console.log(`D1b:${tag}`, typeof value === "string" ? value : JSON.stringify(value))

const hardStop = setTimeout(() => {
  console.log("D1b:TIMEOUT hard 15s")
  process.exit(9)
}, 15_000)
hardStop.unref()

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
}
const sessionId = "0192cc00cc00cc00cc00cc00cc"
const nonce = "2".repeat(32)
const hello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId,
  nonce,
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

const helloBytes = encodeClientHello(hello)
if (helloBytes instanceof ProtocolError) {
  log("encode.fail", String(helloBytes.reason))
  process.exit(1)
}
proc.stdin.write(helloBytes)
proc.stdin.flush()

const decoder = new FrameDecoder()
let phase: "await-hello" | "await-ack" | "done" = "await-hello"
let ackSeen = false

const driver = (async () => {
  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    const frames = decoder.feed(chunk)
    if (frames instanceof Error) {
      log("decode.fail", frames.message)
      return
    }
    for (const frame of frames) {
      if (frame.messageClass !== "control") continue
      if (phase === "await-hello") {
        const decoded = decodeHostHello(frame.payload)
        if (decoded instanceof ProtocolError) continue // may be a heartbeat; ignore
        log("handshake.ok", { sessionId: decoded.sessionId })
        const shutdown: ControlEnvelope = {
          protocolVersion: 1,
          kind: "shutdown",
          sessionId,
          nonce,
          messageId: "1",
          requestId: "1",
          body: {},
        }
        const bytes = encodeControlEnvelope(shutdown)
        if (bytes instanceof ProtocolError) {
          log("shutdown.encode.fail", String(bytes.reason))
          return
        }
        proc.stdin.write(bytes)
        proc.stdin.flush()
        phase = "await-ack"
        continue
      }
      if (phase === "await-ack") {
        const env = decodeControlEnvelope(frame.payload)
        if (env instanceof ProtocolError) continue
        if (env.kind === "heartbeat") continue
        log("reply", { kind: env.kind, responseTo: env.responseTo ?? null, body: env.body })
        if (env.kind === "shutdown-ack") {
          ackSeen = true
          phase = "done"
          return
        }
      }
    }
  }
})()

await Promise.race([driver, new Promise((r) => setTimeout(r, 8_000))])

const exitStart = Bun.nanoseconds()
const exited = await Promise.race([
  proc.exited.then((code) => ({ kind: "exited", code })),
  new Promise((r) => setTimeout(() => r({ kind: "timeout-3s" }), 3_000)),
])
log("graceful", {
  ackSeen,
  ...(exited as object),
  waitedMs: Math.round((Bun.nanoseconds() - exitStart) / 1e6),
  exitCode: proc.exitCode,
  signalCode: proc.signalCode,
})

if (proc.exitCode === null && proc.signalCode === null) {
  proc.kill()
  await proc.exited
}

clearTimeout(hardStop)
console.log("D1b:DONE")

// D1 — Bun.spawn framed-stdio round-trip on Windows.
// Spawns the real 2C host wrapper, writes a framed client.hello to its stdin,
// reads the framed host.hello back through a FrameDecoder. Also probes:
//   - whether a Bun.spawn failure (bad cmd) throws, and if the throw is Error;
//   - proc.stdin.write return value (backpressure/flush semantics);
//   - how many stdout events carry the reply (fragmentation);
//   - how EOF/child-exit surfaces on proc.exited after stdin is closed.
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
  console.log(`D1:${tag}`, typeof value === "string" ? value : JSON.stringify(value))

const hardStop = setTimeout(() => {
  console.log("D1:TIMEOUT hard 15s")
  process.exit(9)
}, 15_000)
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
  sessionId: "0192aa00aa00aa00aa00aa00aa",
  nonce: "0".repeat(32),
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "probe",
  sourceHash: "0".repeat(64),
  sourceKitApiVersion: CURRENT_KIT_API_VERSION,
  runtimeDeclaration,
  limits: PROTOCOL_HARD_LIMITS,
}

// --- Part A: does a bad Bun.spawn throw, and is the throw instanceof Error? ---
{
  const attempt = (() => {
    try {
      const bad = Bun.spawn({
        cmd: ["C:/no/such/binary_termcraft_xyz.exe", "_host", "--stdio"],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      return { threw: false, proc: bad }
    } catch (e) {
      return {
        threw: true,
        isError: e instanceof Error,
        ctor: (e as { constructor?: { name?: string } })?.constructor?.name ?? null,
        name: (e as { name?: string })?.name ?? null,
        code: (e as { code?: unknown })?.code ?? null,
        message: String((e as { message?: unknown })?.message ?? e),
      }
    }
  })()
  log("badspawn", attempt.threw ? { ...attempt, proc: undefined } : "did-not-throw-sync")
  if (!attempt.threw && attempt.proc) {
    const code = await attempt.proc.exited.catch((e) => `exited-rejected: ${String(e)}`)
    log("badspawn.exited", code)
  }
}

// --- Part B: real round-trip against the host wrapper ---
const wrapperPath = `${import.meta.dir}/host-wrapper.ts`
const proc = Bun.spawn({
  cmd: [process.execPath, wrapperPath, "_host", "--stdio"],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

const framed = encodeClientHello(hello)
if (framed instanceof ProtocolError) {
  log("encode.fail", String(framed.reason))
  process.exit(1)
}

const writeReturn = proc.stdin.write(framed)
log("stdin.write.return", {
  typeof: typeof writeReturn,
  isPromise: typeof (writeReturn as { then?: unknown })?.then === "function",
  value: typeof writeReturn === "number" ? writeReturn : String(writeReturn),
  framedBytes: framed.byteLength,
})
proc.stdin.flush()

const decoder = new FrameDecoder()
let stdoutEvents = 0
let controlFrames = 0
let gotHostHello = false
const start = Bun.nanoseconds()

for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
  stdoutEvents += 1
  const frames = decoder.feed(chunk)
  if (frames instanceof Error) {
    log("decode.fail", frames.message)
    break
  }
  for (const frame of frames) {
    if (frame.messageClass !== "control") {
      log("frame.unexpected-class", frame.messageClass)
      continue
    }
    controlFrames += 1
    if (!gotHostHello) {
      const decoded = decodeHostHello(frame.payload)
      if (decoded instanceof ProtocolError) {
        log("hosthello.decode.fail", { reason: String(decoded.reason), code: decoded.code })
      } else {
        gotHostHello = true
        log("hosthello.ok", {
          latencyMs: Math.round((Bun.nanoseconds() - start) / 1e6),
          stdoutEvents,
          sessionId: decoded.sessionId,
          nonce: decoded.nonce,
          selectedFramingVersion: decoded.selectedFramingVersion,
          selectedProtocolVersion: decoded.selectedProtocolVersion,
          negotiatedLimits: decoded.limits,
          runtimeModule: decoded.runtimeDeclaration.module,
        })
      }
    }
  }
  if (gotHostHello) break
}

log("stdout.summary", { stdoutEvents, controlFrames, gotHostHello })

// --- Part C: EOF behaviour — close stdin, does the child self-exit? ---
proc.stdin.end()
const eofStart = Bun.nanoseconds()
const exitedRace = await Promise.race([
  proc.exited.then((code) => ({ kind: "exited", code })),
  new Promise((resolve) =>
    setTimeout(() => resolve({ kind: "timeout-3s" }), 3_000),
  ),
])
log("eof.exit", {
  ...(exitedRace as object),
  waitedMs: Math.round((Bun.nanoseconds() - eofStart) / 1e6),
  exitCode: proc.exitCode,
  signalCode: proc.signalCode,
})

if (proc.exitCode === null && proc.signalCode === null) {
  proc.kill()
  await proc.exited
  log("eof.forced-kill-needed", { exitCode: proc.exitCode, signalCode: proc.signalCode })
}

// Drain any stderr for diagnostics.
const stderrText = await new Response(proc.stderr as ReadableStream).text()
log("child.stderr", stderrText.slice(0, 500))

clearTimeout(hardStop)
console.log("D1:DONE")

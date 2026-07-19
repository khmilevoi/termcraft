import { FrameDecoder } from "infrastructure/framing"
import {
  encodeControlEnvelope,
  encodeFrameEnvelope,
  encodeHostHello,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import { createHeadlessRenderer } from "../../render"
import { createHostSession } from "./host-state-machine"
import { loadPage } from "./source-mount"
import { registerRuntimeResolver } from "./resolver"
import type { ExitRequest, OutboundMessage, HostSessionDeps } from "../types"

const HEARTBEAT_INTERVAL_MS = 1000

/** True iff argv requests `_host --stdio` (compiled or `bun run`; Spike E). */
export function parseHostArgs(argv: string[]): boolean {
  const hostIndex = argv.indexOf("_host")
  if (hostIndex === -1) return false
  return argv.indexOf("--stdio") > hostIndex
}

/** The transport-and-lifecycle dependencies of the `_host` child. */
export interface HostStdioIo {
  readonly argv: string[]
  readonly input: AsyncIterable<Uint8Array>
  readonly output: (bytes: Uint8Array) => void
  readonly now: () => number
  readonly exit: (code: number) => void
  readonly deps: {
    readonly runtimeDeclaration: RuntimeDeclarationBundleV1
    readonly limits: typeof PROTOCOL_HARD_LIMITS
    readonly createRenderer?: HostSessionDeps["createRenderer"]
  }
}

/**
 * Run the host-side protocol loop over an injected byte transport. It feeds a
 * `FrameDecoder` from `io.input`, drives a `HostSession`, encodes each outbound
 * logical message with the 2A codecs and writes it via `io.output`, ticks the
 * heartbeat on `io.now`, and on the session's `ExitRequest` stops the heartbeat,
 * destroys the live renderer, flushes, and calls `io.exit` (Spike D — the child
 * never self-exits). A framing/decoder failure terminates the incarnation.
 */
export async function runHostStdio(io: HostStdioIo): Promise<void> {
  registerRuntimeResolver()

  let liveRenderer: { destroy(): void } | null = null
  let exited = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const performExit = (request: ExitRequest) => {
    if (exited) return
    exited = true
    clearInterval(heartbeat)
    liveRenderer?.destroy()
    liveRenderer = null
    io.exit(request.code)
    resolveDone()
  }

  const encodeOutbound = (message: OutboundMessage): ProtocolError | Uint8Array => {
    if (message.type === "host-hello") return encodeHostHello(message.payload)
    if (message.type === "frame") return encodeFrameEnvelope(message.payload)
    return encodeControlEnvelope(message.payload)
  }

  const session = createHostSession({
    runtimeDeclaration: io.deps.runtimeDeclaration,
    limits: io.deps.limits,
    loadPage,
    createRenderer: async (size) => {
      const renderer = await (io.deps.createRenderer ?? createHeadlessRenderer)(size)
      liveRenderer = renderer
      return renderer
    },
    now: io.now,
    send: (message) => {
      const bytes = encodeOutbound(message)
      if (bytes instanceof ProtocolError) {
        performExit({ code: 1, reason: String(bytes.reason) })
        return
      }
      io.output(bytes)
    },
    requestExit: performExit,
  })

  const heartbeat = setInterval(() => session.emitHeartbeat(), HEARTBEAT_INTERVAL_MS)

  const decoder = new FrameDecoder()
  const pump = (async () => {
    try {
      for await (const chunk of io.input) {
        if (exited) break
        const frames = decoder.feed(chunk)
        if (frames instanceof Error) {
          performExit({ code: 1, reason: frames.message })
          return
        }
        for (const frame of frames) {
          if (exited) break
          // stdout is protocol-only; the child only receives control-class inbound.
          await session.receiveControlPayload(frame.payload)
        }
      }
    } catch (cause) {
      // A live stdin stream can throw mid-iteration; route it to a typed exit so
      // the heartbeat interval is never leaked (the error is not swallowed — it
      // drives termination and surfaces in the exit reason).
      performExit({ code: 1, reason: `stdin iteration failed: ${String(cause)}` })
    }
  })()

  // The race ends on either signal (input closed, or an exit requested). The
  // `finally` guarantees the heartbeat interval is cleared on every path, so a
  // pump rejection can never leak it.
  try {
    await Promise.race([done, pump])
  } finally {
    clearInterval(heartbeat)
    if (!exited) resolveDone()
  }
  await done
}

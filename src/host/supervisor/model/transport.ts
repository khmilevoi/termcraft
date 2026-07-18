import { FrameDecoder } from "../../../infrastructure/framing"
import { ProtocolError } from "../../protocol"
import { SupervisorError } from "./errors"
import type { SpawnedChild } from "../types"

/** One decoded outer frame from the child's stdout (framing §5). */
export interface InboundMessage {
  readonly messageClass: "control" | "data"
  readonly payload: Uint8Array
}

const STDERR_TAIL_LIMIT = 65_536

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown })?.then === "function"
}

/**
 * Write already-framed bytes to child stdin, awaiting the possibly-async write
 * then flush (D1). Never infers liveness from the write (D2). A thrown/rejected
 * write becomes a typed `TRANSPORT_ERROR`.
 */
export async function writeFramed(child: SpawnedChild, bytes: Uint8Array): Promise<SupervisorError | null> {
  const attempt = await (async () => {
    try {
      const wrote = child.stdin.write(bytes)
      if (isThenable(wrote)) await wrote
      const flushed = child.stdin.flush()
      if (isThenable(flushed)) await flushed
      return null
    } catch (cause) {
      return new SupervisorError({
        code: "TRANSPORT_ERROR",
        reason: `stdin write failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      })
    }
  })()
  return attempt
}

/**
 * Read the child's stdout through ONE `FrameDecoder`, yielding decoded messages.
 * On a framing violation it yields a `ProtocolError(MALFORMED_PROTOCOL)` and
 * returns — no byte-stream resynchronization (§5). On a stream read failure it
 * yields a `SupervisorError(TRANSPORT_ERROR)` and returns. EOF ends the generator.
 */
export async function* readInbound(
  child: SpawnedChild,
): AsyncGenerator<ProtocolError | SupervisorError | InboundMessage> {
  const decoder = new FrameDecoder()
  try {
    for await (const chunk of child.stdout) {
      const frames = decoder.feed(chunk)
      if (frames instanceof Error) {
        yield new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: frames.message, cause: frames })
        return
      }
      for (const frame of frames) yield frame
    }
  } catch (cause) {
    yield new SupervisorError({
      code: "TRANSPORT_ERROR",
      reason: `stdout read failed: ${String((cause as { message?: unknown })?.message ?? cause)}`,
      cause: cause instanceof Error ? cause : undefined,
    })
  }
}

export interface StderrDrain {
  tail(): Uint8Array
  discarded(): number
  /** Resolves when the stderr stream ends (child exit) — for deterministic tests. */
  readonly settled: Promise<void>
  stop(): void
}

/**
 * Drain stderr concurrently into a bounded 64 KiB tail, dropping oldest bytes and
 * counting discards (§8). A large burst does not block stdout (D3), but draining
 * is required for the tail, memory bound, and the 2D-3 flood limit.
 */
export function createStderrDrain(child: SpawnedChild): StderrDrain {
  let tail = new Uint8Array(0)
  let discarded = 0
  let stopped = false
  const loop = (async () => {
    try {
      for await (const chunk of child.stderr) {
        if (stopped) break
        const joined = new Uint8Array(tail.length + chunk.length)
        joined.set(tail, 0)
        joined.set(chunk, tail.length)
        if (joined.length > STDERR_TAIL_LIMIT) {
          discarded += joined.length - STDERR_TAIL_LIMIT
          tail = joined.slice(joined.length - STDERR_TAIL_LIMIT)
        } else {
          tail = joined
        }
      }
    } catch (cause) {
      // A stderr read failure is non-fatal: the tail keeps what it captured and the
      // incarnation's fate is decided by proc.exited / the stdout path. But the drain
      // feeds the §13 diagnostics (stderr tail + discarded-byte count), so the ignored
      // branch must leave a trace — never a silent swallow (errore rule 21). No logger
      // seam exists in 2D-1; a diagnostics sink (2D-3) supersedes this console.warn.
      console.warn("host-supervisor: stderr drain read failed:", cause instanceof Error ? cause.message : String(cause))
    }
  })()
  return {
    tail: () => tail,
    discarded: () => discarded,
    settled: loop,
    stop: () => {
      stopped = true
    },
  }
}

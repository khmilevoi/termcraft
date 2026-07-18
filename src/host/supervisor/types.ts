import type {
  ControlEnvelope,
  FrameEnvelope,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../types"
import type { Clock } from "./model/clock"
import type { SupervisorError } from "./model/errors"

/** The injected spawn command — an argument array, never a shell string (§13, Spike E). */
export interface SpawnCommand {
  readonly cmd: readonly string[]
}

/** The child's stdin sink. `write`/`flush`/`end` may be sync or async (D1). */
export interface ChildStdin {
  write(bytes: Uint8Array): unknown
  flush(): unknown
  end(): unknown
}

/**
 * The injected `Bun.spawn` seam. A test double scripts every field; the
 * production adapter wraps `Bun.spawn`. `exited` is the sole liveness oracle
 * (D2); classify termination by `exitCode` (clean) vs `signalCode` (forced).
 */
export interface SpawnedChild {
  readonly stdin: ChildStdin
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
  readonly exitCode: number | null
  readonly signalCode: string | null
}

/** Spawns one child incarnation, or returns a typed failure (§12, §13). */
export type SpawnFn = (command: SpawnCommand) => SupervisorError | SpawnedChild

/** The serialized session lifecycle (§10). `failed`/restart edges are driven in 2D-3. */
export type SessionPhase =
  | "created"
  | "spawning"
  | "negotiating"
  | "mounting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"

/** A post-`ready` control-class event routed to the injected sink (broker/mailbox in 2D-2). */
export interface ControlEvent {
  readonly kind: string
  readonly envelope: ControlEnvelope
}

/** The accepted startup outcome (§6.6). `firstFrame` is the initial full frame if it arrived. */
export interface ReadyOutcome {
  readonly identity: HostSessionIdentity
  readonly negotiatedLimits: PublicLimits
  readonly ready: ControlEnvelope
  readonly firstFrame: FrameEnvelope | null
}

/** The terminal stop result (§9). Always reaches `stopped`; `forced` records the path. */
export interface StopOutcome {
  readonly phase: "stopped"
  readonly forced: boolean
  readonly exitCode: number | null
  readonly signalCode: string | null
  readonly reason: string
}

/** Injected dependencies of one session incarnation. */
export interface HostSessionDeps {
  readonly spawn: SpawnFn
  readonly command: SpawnCommand
  readonly clock: Clock
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly offeredLimits?: PublicLimits
  readonly onFrame?: (frame: FrameEnvelope) => void
  readonly onControlEvent?: (event: ControlEvent) => void
  /** Reuse a stable sessionId across restart (2D-3); a new nonce is always minted. */
  readonly sessionId?: string
}

/** The typed session handle returned to Kernel code (§3.1). No raw streams/process. */
export interface HostSession {
  readonly identity: HostSessionIdentity
  readonly phase: SessionPhase
  start(): Promise<ProtocolError | SupervisorError | ReadyOutcome>
  stop(): Promise<StopOutcome>
}

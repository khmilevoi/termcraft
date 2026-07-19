import type {
  ControlEnvelope,
  FrameEnvelope,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol"
import type { HostSessionIdentity, HostSessionSpec, InteractionMode, PreviewFrame, PreviewIdentity, Size } from "../types"
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
  /** A fatal post-`ready` outcome (heartbeat timeout, unresponsive, crash, protocol error). 2D-3 consumes it. */
  readonly onFatal?: (error: SupervisorError | ProtocolError) => void
  /** Test seams — default to the real constructors. The broker guard needs the minted identity. */
  readonly createBroker?: (guard: { sessionId: string; nonce: string; sourceHash: string }) => FrameBroker
  readonly createRequestTable?: (
    clock: Clock,
    opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number },
  ) => RequestTable
  readonly createWatchdog?: (
    clock: Clock,
    opts: { onUnhealthy: (error: SupervisorError) => void },
  ) => HeartbeatWatchdog
}

/** The typed session handle returned to Kernel code (§3.1). No raw streams/process. */
export interface HostSession {
  readonly identity: HostSessionIdentity
  readonly phase: SessionPhase
  start(): Promise<ProtocolError | SupervisorError | ReadyOutcome>
  stop(): Promise<StopOutcome>
  /** Complete immutable frames from the internal broker (§3.2). Only meaningful after `ready`. */
  readonly frames: AsyncIterable<PreviewFrame>
  /** Correlated post-`ready` requests. Resolve on the child's response, a 2 s QUERY_TIMEOUT, or teardown. */
  resize(size: Size): Promise<ControlEnvelope | ProtocolError | SupervisorError>
  setMode(mode: InteractionMode): Promise<ControlEnvelope | ProtocolError | SupervisorError>
  ping(): Promise<ControlEnvelope | ProtocolError | SupervisorError>
}

/** The UI-facing preview facade subset the 2C child supports today (§3.2). */
export interface PreviewSession {
  readonly identity: PreviewIdentity
  readonly mode: "preview" | "historical"
  /** The effective interaction mode; changes ONLY on an accepted set-mode response (§7). */
  readonly interactionMode: InteractionMode
  readonly frames: AsyncIterable<PreviewFrame>
  resize(size: Size): void
  setMode(mode: InteractionMode): void
  retry(): void
  close(): Promise<void>
}

/** Capacity-1 latest-wins preview frame broker (§8, §10.1). */
export interface FrameBroker {
  /** Atomic capacity-1 replace. Rejects a frame failing the §10.1 identity/seq guard. */
  publish(frame: FrameEnvelope): "accepted" | "stale"
  readonly frames: AsyncIterable<PreviewFrame>
  framesCoalesced(): number
  close(): void
}

/** The outstanding request table (§7, §8, §9). Every request has one terminal outcome. */
export interface RequestTable {
  /** Reserve a correlation id; resolves on resolve()/supersede()/timeout/clear. */
  register(requestId: string, kind: string): Promise<ControlEnvelope | ProtocolError | SupervisorError>
  resolve(responseTo: string, envelope: ControlEnvelope): void
  supersede(requestId: string, reason: string): void
  /** Teardown: settle every outstanding request with `error` (or a default TRANSPORT_ERROR). */
  clear(error?: ProtocolError | SupervisorError): void
  size(): number
}

/** The §9 heartbeat / liveness watchdog. Fires `onUnhealthy` at most once. */
export interface HeartbeatWatchdog {
  start(): void
  feedHeartbeat(): void
  noteRequestTimeout(): void
  stop(): void
}

/** A command queued for the ordered outbound control path (§8). */
export interface QueuedCommand {
  readonly kind: string
  readonly envelope: ControlEnvelope
}

/** The outcome of a coalescible `coalesce` (§8): a new tail slot, or a replace that supersedes the older value. */
export interface CoalesceOutcome {
  readonly status: "added" | "coalesced"
  readonly superseded: ControlEnvelope | null
}

/**
 * The bounded ordered supervisor→host control queue (§8): 256 discrete entries
 * plus one reserved shutdown slot, low-water 128. Discrete commands keep FIFO
 * order and never drop; a full queue rejects a new discrete command with
 * `HOST_BACKPRESSURED`. Coalescible kinds (`resize`/`mousemove`/`hover`) replace
 * an already-pending same-kind value inside the current barrier segment (a
 * discrete command starts a new segment), superseding the older value, and cannot
 * create a new entry while full. `dequeue` gives the reserved shutdown slot
 * priority; draining below the low-water mark after backpressure fires `onWritable`.
 */
export interface ControlQueue {
  enqueue(command: QueuedCommand): "accepted" | SupervisorError
  coalesce(command: QueuedCommand): CoalesceOutcome | SupervisorError
  enqueueShutdown(command: QueuedCommand): "accepted"
  dequeue(): QueuedCommand | null
  size(): number
  hasShutdown(): boolean
  isBackpressured(): boolean
  onWritable(cb: () => void): void
}

/**
 * Rolling-second output flood detection (§8). `noteFrame`/`noteStderr` return a
 * fatal `SupervisorError` (`PROTOCOL_FLOOD` / `STDERR_FLOOD`) when the incarnation
 * exceeds >1000 frame envelopes or >128 MiB frame payload, or >1 MiB stderr, in
 * one rolling second — the supervisor then kills + opens the circuit.
 */
export interface FloodMonitor {
  noteFrame(byteLength: number): SupervisorError | null
  noteStderr(byteLength: number): SupervisorError | null
}

/**
 * The bounded host→supervisor inbound control mailbox (§8): 256 entries plus one
 * reserved terminal slot. `offer` past 256 returns `CONTROL_BACKPRESSURE` (the
 * supervisor then kills the child and uses `offerTerminal` for the failure event).
 */
export interface ControlMailbox {
  offer(event: ControlEvent): "accepted" | SupervisorError
  offerTerminal(event: ControlEvent): void
  drain(): ControlEvent | null
  size(): number
}

/** One restart-policy decision (§10): restart after a backoff, or open the circuit. */
export type RestartAction =
  | { readonly action: "restart"; readonly delayMs: number; readonly attempt: number }
  | { readonly action: "open"; readonly attempts: number; readonly reason: string }

/**
 * The per-`(pageSlug, sourceHash)` restart budget + base-2 backoff + circuit
 * breaker (§10). Pure and clock-free — `now` is a parameter. Shared by preview
 * and historical sessions for one source so opening/closing views cannot evade
 * crash-loop protection.
 */
export interface RestartPolicy {
  /** Classify + record an incarnation failure; decide restart (backoff) or open. */
  recordFailure(key: string, error: ProtocolError | SupervisorError, now: number): RestartAction
  /** True once the circuit is open for this key; latches until `retry`. */
  isOpen(key: string): boolean
  /** Manual retry: clears the key's failure history and closes the circuit once. */
  retry(key: string): void
  /** Budgeted failures still inside the rolling window at `now`. */
  failureCount(key: string, now: number): number
}

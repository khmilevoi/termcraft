import type {
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol";
import type { LayoutNode } from "../render";
import type {
  HostSessionIdentity,
  HostSessionSpec,
  InteractionMode,
  PreviewFrame,
  PreviewIdentity,
  Size,
} from "../types";
import type { Clock } from "./model/clock";
import type { SupervisorError } from "./model/errors";

/** The injected spawn command — an argument array, never a shell string (§13, Spike E). */
export interface SpawnCommand {
  readonly cmd: readonly string[];
}

/** The child's stdin sink. `write`/`flush`/`end` may be sync or async (D1). */
export interface ChildStdin {
  write(bytes: Uint8Array): unknown;
  flush(): unknown;
  end(): unknown;
}

/**
 * The injected `Bun.spawn` seam. A test double scripts every field; the
 * production adapter wraps `Bun.spawn`. `exited` is the sole liveness oracle
 * (D2); classify termination by `exitCode` (clean) vs `signalCode` (forced).
 */
export interface SpawnedChild {
  readonly stdin: ChildStdin;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

/** Spawns one child incarnation, or returns a typed failure (§12, §13). */
export type SpawnFn = (command: SpawnCommand) => SupervisorError | SpawnedChild;

/** The serialized session lifecycle (§10). `failed`/restart edges are driven in 2D-3. */
export type SessionPhase =
  | "created"
  | "spawning"
  | "negotiating"
  | "mounting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

/** A post-`ready` control-class event routed to the injected sink (broker/mailbox in 2D-2). */
export interface ControlEvent {
  readonly kind: string;
  readonly envelope: ControlEnvelope;
}

/** The accepted startup outcome (§6.6). `firstFrame` is the initial full frame if it arrived. */
export interface ReadyOutcome {
  readonly identity: HostSessionIdentity;
  readonly negotiatedLimits: PublicLimits;
  readonly ready: ControlEnvelope;
  readonly firstFrame: FrameEnvelope | null;
}

/** The terminal stop result (§9). Always reaches `stopped`; `forced` records the path. */
export interface StopOutcome {
  readonly phase: "stopped";
  readonly forced: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly reason: string;
}

/** Injected dependencies of one session incarnation. */
export interface HostSessionDeps {
  readonly spawn: SpawnFn;
  readonly command: SpawnCommand;
  readonly clock: Clock;
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  readonly offeredLimits?: PublicLimits;
  readonly onFrame?: (frame: FrameEnvelope) => void;
  readonly onControlEvent?: (event: ControlEvent) => void;
  /** Reuse a stable sessionId across restart (2D-3); a new nonce is always minted. */
  readonly sessionId?: string;
  /** A fatal post-`ready` outcome (heartbeat timeout, unresponsive, crash, protocol error). 2D-3 consumes it. */
  readonly onFatal?: (error: SupervisorError | ProtocolError) => void;
  /**
   * Wires `control-queue.ts`/`control-mailbox.ts` into the live path: fires `"backpressured"`
   * when the OUTBOUND queue crosses to full (a subsequent discrete command then gets
   * `HOST_BACKPRESSURED` instead of being queued) and `"writable"` when it drains back below
   * the low-water mark (§8). A later Kernel adapter turns these into `preview.backpressured` /
   * `preview.writable` EventKinds; `host` only exposes the underlying signal.
   */
  readonly onBackpressureChange?: (state: "backpressured" | "writable") => void;
  /** Test seams — default to the real constructors. The broker guard needs the minted identity. */
  readonly createBroker?: (guard: {
    sessionId: string;
    nonce: string;
    sourceHash: string;
  }) => FrameBroker;
  readonly createRequestTable?: (
    clock: Clock,
    opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number },
  ) => RequestTable;
  readonly createWatchdog?: (
    clock: Clock,
    opts: { onUnhealthy: (error: SupervisorError) => void },
  ) => HeartbeatWatchdog;
  readonly createFloodMonitor?: (clock: Clock) => FloodMonitor;
}

/**
 * Blocker B1's closed host-wire geometry-query kinds (host-supervision §7 request family
 * names). §7.1: the Kernel-level `pin-anchor` refinement travels AS `query-hit` on the
 * wire — "the host protocol closed query families are unchanged" — so this union has no
 * fifth `pin-anchor` member; only the Kernel (a later phase) distinguishes it.
 */
export type GeometryQuery =
  | { readonly kind: "hit"; readonly x: number; readonly y: number }
  | { readonly kind: "rect" | "describe"; readonly elementId: string }
  | { readonly kind: "layout" };

/**
 * One geometry-query outcome (§7.1): the identity of the frame the host actually answered
 * against (so a caller can detect staleness itself) plus a closed, per-kind result record;
 * or the typed `STALE_FRAME` refusal when the requested frame is no longer the host's
 * currently sealed frame. Never a raw `ControlEnvelope` — this is decoded/typed once here,
 * mirroring `resize`/`setMode`'s existing correlated-request shape.
 */
export type GeometryQueryResult =
  | {
      readonly ok: true;
      readonly frameIdentity: FrameIdentity;
      readonly result: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly code: "STALE_FRAME"; readonly reason: string };

/** What one page switch has to name (design §9.2). */
export interface MountPageV1 {
  readonly pageSlug: string;
  readonly entryRelPath: string;
  readonly sourceHash: string;
  readonly kitApiVersion: number;
  readonly size: Size;
  readonly interactionMode: InteractionMode;
  readonly theme: string;
}

/** The typed session handle returned to Kernel code (§3.1). No raw streams/process. */
export interface HostSession {
  /**
   * The incarnation's identity (§3.1, §9.2). `sessionId`/`nonce`/`mode` are stable for the
   * incarnation's whole life; `pageSlug`/`sourceHash`/`kitApiVersion` describe whichever page
   * is CURRENTLY MOUNTED and move on every accepted `mount()` — this is a live getter, not a
   * snapshot taken once at `start()`.
   */
  readonly identity: HostSessionIdentity;
  readonly phase: SessionPhase;
  start(): Promise<ProtocolError | SupervisorError | ReadyOutcome>;
  stop(): Promise<StopOutcome>;
  /** Complete immutable frames from the internal broker (§3.2). Only meaningful after `ready`. */
  readonly frames: AsyncIterable<PreviewFrame>;
  /** Correlated post-`ready` requests. Resolve on the child's response, a 2 s QUERY_TIMEOUT, or teardown. */
  resize(size: Size): Promise<ControlEnvelope | ProtocolError | SupervisorError>;
  setMode(mode: InteractionMode): Promise<ControlEnvelope | ProtocolError | SupervisorError>;
  ping(): Promise<ControlEnvelope | ProtocolError | SupervisorError>;
  /**
   * Blocker B1: `checkHit`/`rectOf`/`describe`/`layoutTree` (design doc §4.2), correlated
   * through the same request table as `resize`/`setMode`/`ping` (2 s `QUERY_TIMEOUT` /
   * `SUPERSEDED` / `TOO_MANY_REQUESTS` all apply unchanged). `frameIdentity` is the frame
   * the CALLER expects to still be current — the Kernel resolves a `FrameToken` to this
   * identity before calling (host-supervision §7.1); this method never mints or resolves
   * tokens itself.
   */
  query(
    frameIdentity: FrameIdentity,
    query: GeometryQuery,
  ): Promise<ProtocolError | SupervisorError | GeometryQueryResult>;
  /**
   * Mount a different page in this live incarnation (design §9.2). Only valid from `ready`.
   * Resolves once the correlated `ready` has arrived; the first frame after it is awaited
   * under its own deadline by a later task, not by this promise.
   *
   * CALLERS MUST SERIALIZE: at most one `mount()` may be outstanding at a time. Calling it
   * again before the previous call's promise has settled is refused (a `SupervisorError`),
   * not queued — overwriting an in-flight mount would orphan its `ready` and could fatal the
   * incarnation over a frame the child was correct to send.
   */
  mount(page: MountPageV1): Promise<ProtocolError | SupervisorError | ControlEnvelope>;
}

/** The UI-facing preview facade subset the 2C child supports today (§3.2). */
export interface PreviewSession {
  readonly identity: PreviewIdentity;
  readonly mode: "preview" | "historical";
  /** The effective interaction mode; changes ONLY on an accepted set-mode response (§7). */
  readonly interactionMode: InteractionMode;
  readonly frames: AsyncIterable<PreviewFrame>;
  resize(size: Size): void;
  setMode(mode: InteractionMode): void;
  /** Blocker B1 — see `HostSession.query`'s doc comment; forwarded verbatim. */
  query(
    frameIdentity: FrameIdentity,
    query: GeometryQuery,
  ): Promise<ProtocolError | SupervisorError | GeometryQueryResult>;
  retry(): void;
  close(): Promise<void>;
}

/** Capacity-1 latest-wins preview frame broker (§8, §10.1). */
export interface FrameBroker {
  /** Atomic capacity-1 replace. Rejects a frame failing the §10.1 identity/seq guard. */
  publish(frame: FrameEnvelope): "accepted" | "stale";
  /** Re-seed the incarnation guard's expected source hash after an accepted mount (§9.2). */
  expect(sourceHash: string): void;
  readonly frames: AsyncIterable<PreviewFrame>;
  framesCoalesced(): number;
  close(): void;
}

/** The outstanding request table (§7, §8, §9). Every request has one terminal outcome. */
export interface RequestTable {
  /**
   * Reserve a correlation id; resolves on resolve()/supersede()/timeout/clear. `timeoutMs`
   * overrides the table's default budget for this ONE request (`mount` names §9.4's mount
   * deadline, five times the default); omitted, the table's own default applies.
   */
  register(
    requestId: string,
    kind: string,
    timeoutMs?: number,
  ): Promise<ControlEnvelope | ProtocolError | SupervisorError>;
  resolve(responseTo: string, envelope: ControlEnvelope): void;
  supersede(requestId: string, reason: string): void;
  /** Teardown: settle every outstanding request with `error` (or a default TRANSPORT_ERROR). */
  clear(error?: ProtocolError | SupervisorError): void;
  size(): number;
}

/** The §9 heartbeat / liveness watchdog. Fires `onUnhealthy` at most once. */
export interface HeartbeatWatchdog {
  start(): void;
  feedHeartbeat(): void;
  noteRequestTimeout(): void;
  stop(): void;
}

/** A command queued for the ordered outbound control path (§8). */
export interface QueuedCommand {
  readonly kind: string;
  readonly envelope: ControlEnvelope;
}

/** The outcome of a coalescible `coalesce` (§8): a new tail slot, or a replace that supersedes the older value. */
export interface CoalesceOutcome {
  readonly status: "added" | "coalesced";
  readonly superseded: ControlEnvelope | null;
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
  enqueue(command: QueuedCommand): "accepted" | SupervisorError;
  coalesce(command: QueuedCommand): CoalesceOutcome | SupervisorError;
  enqueueShutdown(command: QueuedCommand): "accepted";
  dequeue(): QueuedCommand | null;
  size(): number;
  hasShutdown(): boolean;
  isBackpressured(): boolean;
  onWritable(cb: () => void): void;
}

/**
 * Rolling-second output flood detection (§8). `noteFrame`/`noteStderr` return a
 * fatal `SupervisorError` (`PROTOCOL_FLOOD` / `STDERR_FLOOD`) when the incarnation
 * exceeds >1000 frame envelopes or >128 MiB frame payload, or >1 MiB stderr, in
 * one rolling second — the supervisor then kills + opens the circuit.
 */
export interface FloodMonitor {
  noteFrame(byteLength: number): SupervisorError | null;
  noteStderr(byteLength: number): SupervisorError | null;
}

/**
 * The bounded host→supervisor inbound control mailbox (§8): 256 entries plus one
 * reserved terminal slot. `offer` past 256 returns `CONTROL_BACKPRESSURE` (the
 * supervisor then kills the child and uses `offerTerminal` for the failure event).
 */
export interface ControlMailbox {
  offer(event: ControlEvent): "accepted" | SupervisorError;
  offerTerminal(event: ControlEvent): void;
  drain(): ControlEvent | null;
  size(): number;
}

/** One restart-policy decision (§10): restart after a backoff, or open the circuit. */
export type RestartAction =
  | { readonly action: "restart"; readonly delayMs: number; readonly attempt: number }
  | { readonly action: "open"; readonly attempts: number; readonly reason: string };

/**
 * The per-`(treeRevision, pageSlug)` restart budget + base-2 backoff + circuit breaker (§10;
 * design-tree §9.2). Pure and clock-free — `now` is a parameter. Keyed by the page that was
 * mounting when a failure occurred, NOT by `supervisor.ts`'s own session key — since design-tree
 * phase 3 Task 5 one incarnation serves a whole tree revision, so a page-scoped restart key is
 * what stops one looping page from spending the budget of every other page sharing it.
 */
export interface RestartPolicy {
  /** Classify + record an incarnation failure; decide restart (backoff) or open. */
  recordFailure(key: string, error: ProtocolError | SupervisorError, now: number): RestartAction;
  /** True once the circuit is open for this key; latches until `retry`. */
  isOpen(key: string): boolean;
  /** Manual retry: clears the key's failure history and closes the circuit once. */
  retry(key: string): void;
  /** Budgeted failures still inside the rolling window at `now`. */
  failureCount(key: string, now: number): number;
}

/**
 * A capacity-1 latest-wins relay of already-built `PreviewFrame` values that
 * outlives individual incarnations (§10.1). The supervisor points it at the
 * current incarnation's guarded `frames`; on restart the old incarnation's broker
 * closes and the relay is re-pointed at the new incarnation, so a stable UI
 * consumer keeps ONE `frames` iterator across automatic restarts. No identity
 * guard — the per-incarnation broker already validated every frame.
 */
export interface PreviewRelay {
  readonly frames: AsyncIterable<PreviewFrame>;
  publish(frame: PreviewFrame): void;
  close(): void;
}

/** The observable lifecycle state of one supervised key (§10). */
export type SupervisorState =
  | "starting"
  | "queued"
  | "ready"
  | "backoff"
  | "circuit-open"
  | "stopped";

/**
 * A bounded, structured lifecycle diagnostic emitted to the injected sink (§13).
 * No absolute paths, env values, or source contents — only the source-hash prefix
 * and nonce-free identity. Phase 6 wires this onto the Kernel event channel.
 */
export interface SupervisorEvent {
  readonly type: "spawning" | "ready" | "backoff" | "circuitOpened" | "stopped";
  readonly key: string;
  readonly sessionId: string;
  readonly pageSlug: string;
  readonly sourceHashPrefix: string;
  /** restart attempt (spawning/backoff) */
  readonly attempt?: number;
  /** backoff delay before the next attempt (backoff) */
  readonly delayMs?: number;
  /** total failed incarnations (circuitOpened) */
  readonly attempts?: number;
  /** bounded reason (backoff/circuitOpened/stopped) */
  readonly reason?: string;
  /**
   * The FAILING INCARNATION's own error, on `circuitOpened` only — distinct from `reason`,
   * which reports the restart policy's verdict ("restart budget exhausted (3 in 60000ms)").
   * Without these the Kernel can say a preview stopped but never why, and the repair message
   * the UI offers has nothing to quote.
   *
   * §13-safe, but NOT for one single reason — the text arrives by three different routes and
   * each is bounded on its own terms:
   *   - a failure the host itself reported: `session.ts`'s `mapHostError` slices the envelope's
   *     reason to 200 characters (`DESIGN_RENDER_FAILED` and every `ProtocolError`);
   *   - a failure the OS reported: `spawn.ts` and `transport.ts` build the reason from
   *     `osFailureReason`, which relays the structured code and syscall and never the throw's
   *     own message — libuv concatenates the offending absolute path into that message;
   *   - everything else: literal strings written in this repository (timeouts, `CHILD_EXITED`).
   * No route relays free-form OS or host text verbatim, which is what §13 actually forbids.
   */
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

/**
 * Blocker B4's resolution: `HostSupervisor.preview()` returns THIS — a `PreviewSession`
 * (host-supervision §3.2's UI-facing shape: identity, mode, interactionMode, frames,
 * resize, setMode, query, retry, close) composed with the supervisor's own restart/
 * backoff/circuit management, not the narrower crash-loop-only handle that used to be
 * `PreviewHandle` (see `preview-session.ts`'s header and `supervisor.ts`'s `sessionFor`
 * for where the composition lives). `identity` (nonce omitted) and `frames` survive
 * automatic restart exactly as the old `PreviewHandle` did; `resize`/`setMode`/`query`
 * delegate to whichever incarnation is CURRENTLY live and are the part that did not exist
 * before this decision. `state()` is host's own addition beyond the UI-facing shape —
 * lifecycle observability the Kernel-facing `core/ports` narrowing is free to omit.
 */
export interface SupervisedPreviewSession extends PreviewSession {
  /** The current supervised lifecycle state (§10) — an observability extra past the base facade. */
  state(): SupervisorState;
  /**
   * Overrides the base facade's fire-and-forget `resize(): void` with the real disposition
   * (Task 11 — resize-race-diagnosis.md). `preview.sessionReady` fires the instant this
   * key's `KeyState` exists, not when the incarnation can accept control requests, so a
   * resize issued in that window used to reach a not-yet-ready `HostSession` and be
   * refused-then-swallowed. `undefined` now covers BOTH "dispatched to the live
   * incarnation" and "buffered because no incarnation is ready yet" (last-wins, flushed
   * from `supervisor.ts`'s ready hook — host-supervision §8's coalescible-resize
   * contract). A `SupervisorError` means a LIVE incarnation genuinely refused or dropped
   * the request, so `host-adapters/host-supervisor.ts` can report that instead of a
   * fabricated success.
   */
  resize(size: Size): Promise<SupervisorError | undefined>;
}

/** Injected dependencies of the standalone `HostSupervisor` (§13). */
export interface HostSupervisorDeps {
  readonly clock: Clock;
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  /**
   * The spawn command for a spec (the execPath-vs-dev branch is phase-8's job, Spike E).
   * `null` means "the warm spare's command, before any spec exists" (design-tree phase 3 Task
   * 6): the production implementation ignores `spec` entirely — `createHostSpawnCommand` builds
   * `[execPath, srcRoot, "_host", "--stdio"]` from the environment alone — so every incarnation
   * and every spare share the identical argv. A caller whose command genuinely depends on the
   * spec must decide what a spare's command is; there is no defensible default, which is why
   * `null` is a real argument here and not silently coerced to a fabricated spec.
   */
  readonly spawnFor: (spec: HostSessionSpec | null) => SpawnCommand;
  readonly spawn: SpawnFn;
  /** Mint a stable per-key sessionId (UUIDv7); a fresh nonce is minted per incarnation. */
  readonly mintSessionId: () => string;
  readonly offeredLimits?: PublicLimits;
  /** Bounded lifecycle diagnostics sink (§13). Phase 6 wires it to the Kernel. */
  readonly onEvent?: (event: SupervisorEvent) => void;
  /** Workspace-trust gate checked before any host starts (§13); phase-4 ledger injects the real one. */
  readonly checkTrust?: () => SupervisorError | null;
  /** Test seam: the incarnation factory. Defaults to `createHostSession`. */
  readonly createSession?: (spec: HostSessionSpec, deps: HostSessionDeps) => HostSession;
  /** ≤10 live host processes globally (§13). */
  readonly maxGlobalHosts?: number;
  /** Kernel-owned bounded start queue depth past the global limit (§13). */
  readonly startQueueCapacity?: number;
  /**
   * How many booted-but-unhandshaked spares to keep warm (design §9.3: "one booted …
   * spare"). Defaults to 1 — a tuning knob with a design-stated value, not an input a caller
   * must decide, which is why this is the one optional field `spare-pool.ts` itself takes.
   */
  readonly spareCapacity?: number;
}

/** Injected dependencies for a one-shot `smoke`/`export` session (§4, §11.3, §11.4). */
export interface OneShotDeps {
  readonly spawn: SpawnFn;
  readonly command: SpawnCommand;
  readonly clock: Clock;
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  readonly offeredLimits?: PublicLimits;
  /** A stable sessionId for diagnostics; a fresh nonce is always minted. */
  readonly sessionId?: string;
}

/**
 * The typed result of a one-shot `smoke`/`export` session (§4): the single sealed
 * stand-in frame (nonce-free), the `ready` metadata envelope, the resolved layout tree
 * sealed alongside it, and the child's exit code. A one-shot NEVER restarts — a failure
 * is itself the result. NOTE: `frame` is the documented non-conformant MVP stand-in (a
 * styled snapshot, not the design's bulk frame schema) and must NOT be routed to any
 * preview stream. `layout` (WP-5 Task A2) is the REAL resolved tree, decoded from the
 * `ready` body's `layout` field — embedded there because the one-shot child exits before
 * any correlated `query-layout` request could ever reach it
 * (`host-state-machine.ts`'s `handleMount`, `:205-208`).
 */
export interface OneShotResult {
  readonly identity: PreviewIdentity;
  readonly frame: PreviewFrame;
  readonly ready: ControlEnvelope;
  readonly negotiatedLimits: PublicLimits;
  readonly exitCode: number | null;
  readonly layout: LayoutNode;
}

/** One export task: a captured source at one requested size (§11.4), ordered by manifest then (w,h). */
export interface ExportTask {
  readonly spec: HostSessionSpec;
  /** Project page order (manifest order) — the primary publish-order key (§11.4). */
  readonly manifestIndex: number;
}

/** One export task's terminal outcome, tagged by its manifest index for in-order assembly. */
export interface ExportTaskOutcome {
  readonly manifestIndex: number;
  readonly spec: HostSessionSpec;
  readonly result: ProtocolError | SupervisorError | OneShotResult;
}

/**
 * The bounded export worker pool (§11.4): `min(4, max(1, floor(cpu/2)))` workers by
 * default (machine-local override 1–8), a ready queue holding at most twice the
 * worker count, and results published only in manifest/(w,h) order — never
 * completion order — so pool scheduling cannot change package bytes. On any task
 * failure it cancels pending tasks and reports the failure (all-or-nothing).
 */
export interface ExportPool {
  run(tasks: readonly ExportTask[]): Promise<ProtocolError | SupervisorError | ExportTaskOutcome[]>;
}

/**
 * The standalone Kernel-side supervisor that owns multiple preview sessions (§2, §10, §13). One
 * incarnation is keyed by `treeRevision` alone and mounts one page at a time (design-tree §9.2,
 * phase 3 Task 5); the per-`(treeRevision, pageSlug)` restart budget + backoff + circuit is a
 * DIFFERENT key from the session's own, so one page looping does not spend every other page's
 * budget. The ≤10 global host limit + 64-deep `HOST_CAPACITY` start queue, and manual retry.
 * Phase 6 injects it behind the Kernel command/event boundary.
 */
export interface HostSupervisor {
  preview(spec: HostSessionSpec): SupervisedPreviewSession | SupervisorError;
  /**
   * Live (non-stopped, non-queued) incarnation count across all keys, PLUS the warm spare
   * pool's size (design §9.3, §13 ≤10) — a spare is a real host process, so the ≤10 cap has to
   * see it even though admission itself does not (a new key always takes the spare before
   * spawning).
   */
  liveCount(): number;
  stopAll(): Promise<void>;
}

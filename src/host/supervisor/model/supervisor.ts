import { PROTOCOL_HARD_LIMITS } from "../../protocol";
import type { FrameIdentity, ProtocolError } from "../../protocol";
import type { HostSessionSpec, InteractionMode, Size } from "../../types";
import type {
  GeometryQuery,
  GeometryQueryResult,
  HostSession,
  HostSessionDeps,
  HostSupervisor,
  HostSupervisorDeps,
  PreviewRelay,
  SupervisedPreviewSession,
  SupervisorEvent,
  SupervisorState,
} from "../types";
import type { Clock, TimerHandle } from "./clock";
import { SupervisorError } from "./errors";
import { createPreviewRelay } from "./preview-relay";
import { createRestartPolicy } from "./restart-policy";
import { createHostSession } from "./session";

const DEFAULT_MAX_GLOBAL_HOSTS = 10;
const DEFAULT_START_QUEUE_CAPACITY = 64;

/** Per-key supervised session state. One `KeyState` lives for one logical `sessionId`. */
interface KeyState {
  readonly key: string;
  spec: HostSessionSpec;
  readonly sessionId: string;
  readonly relay: PreviewRelay;
  session: SupervisedPreviewSession | null;
  current: HostSession | null;
  /** The effective interaction mode, tracked exactly as `preview-session.ts`'s single-
   * incarnation facade does — updated only from an ACCEPTED `ready`/`set-mode` response
   * (§6.6/§7), re-seeded on every restart's fresh `ready` (never optimistically). */
  interactionMode: InteractionMode;
  /** One failure per incarnation: guards the start()-error and onFatal channels from double-counting. */
  incarnationFailed: boolean;
  backoffTimer: TimerHandle | null;
  pumpTask: Promise<void>;
  state: SupervisorState;
  closed: boolean;
}

/**
 * The standalone Kernel-side `HostSupervisor` (host-supervision §2, §10, §13). It
 * wraps — never rewrites — the 2D-1 single-incarnation `createHostSession`: each
 * attempt is a fresh incarnation with a stable per-key `sessionId` and a fresh
 * nonce, wired so its post-`ready` `onFatal` (or a startup error) drives the pure
 * `RestartPolicy`. A budgeted failure closes the old incarnation (§10.1), waits the
 * base-2 backoff on the injected clock, and respawns; a deterministic/hostile
 * failure or an exhausted budget opens the circuit (one `circuitOpened`), with no
 * background spawn. A stable `PreviewRelay` carries frames across restarts so the
 * UI keeps ONE frame iterator. The ≤10 global host limit funnels overflow into a
 * bounded start queue, then `HOST_CAPACITY`.
 */
export function createHostSupervisor(deps: HostSupervisorDeps): HostSupervisor {
  const createSession = deps.createSession ?? createHostSession;
  const offeredLimits = deps.offeredLimits ?? PROTOCOL_HARD_LIMITS;
  const maxGlobalHosts = deps.maxGlobalHosts ?? DEFAULT_MAX_GLOBAL_HOSTS;
  const startQueueCapacity = deps.startQueueCapacity ?? DEFAULT_START_QUEUE_CAPACITY;
  const clock: Clock = deps.clock;
  const policy = createRestartPolicy();
  const keys = new Map<string, KeyState>();
  const startQueue: KeyState[] = [];

  const keyOf = (spec: HostSessionSpec) => `${spec.pageSlug} ${spec.sourceHash}`;
  const hashPrefix = (spec: HostSessionSpec) => spec.sourceHash.slice(0, 8);
  const emit = (event: SupervisorEvent) => deps.onEvent?.(event);

  // Live = a key that owns a global host slot: starting, ready, OR backoff. A
  // backing-off key is a transient state of an ACTIVE session — it keeps its slot
  // and respawns into it, so a crash-loop can never hand its slot to a queued
  // session and then reclaim it, briefly exceeding the §13 ≤10 hard limit. Only
  // `queued`, `circuit-open`, and `stopped` free the slot.
  const liveCount = () => {
    let live = 0;
    for (const ks of keys.values()) {
      if (ks.state === "starting" || ks.state === "ready" || ks.state === "backoff") live += 1;
    }
    return live;
  };

  function sessionDepsFor(ks: KeyState): HostSessionDeps {
    return {
      spawn: deps.spawn,
      command: deps.spawnFor(ks.spec),
      clock,
      runtimeDeclaration: deps.runtimeDeclaration,
      offeredLimits,
      sessionId: ks.sessionId,
      onFatal: (error) => onIncarnationFatal(ks, error),
    };
  }

  // The relay pump: the SOLE reader of one incarnation's guarded frames, forwarding
  // each into the stable per-key relay. It ends when that incarnation's broker
  // closes (stop/fatal), so a restart starts a fresh pump on the new incarnation.
  async function pumpFrames(ks: KeyState, session: HostSession): Promise<void> {
    for await (const frame of session.frames) {
      if (ks.closed) return;
      ks.relay.publish(frame);
    }
  }

  function startIncarnation(ks: KeyState): void {
    if (ks.closed) return;
    ks.incarnationFailed = false;
    ks.state = "starting";
    const attempt = policy.failureCount(ks.key, clock.now()) + 1;
    emit({
      type: "spawning",
      key: ks.key,
      sessionId: ks.sessionId,
      pageSlug: ks.spec.pageSlug,
      sourceHashPrefix: hashPrefix(ks.spec),
      attempt,
    });
    const session = createSession(ks.spec, sessionDepsFor(ks));
    ks.current = session;
    ks.pumpTask = pumpFrames(ks, session);
    void session.start().then((outcome) => {
      if (ks.closed) return;
      if (outcome instanceof Error) {
        onIncarnationFatal(ks, outcome);
        return;
      }
      if (ks.current !== session) return; // superseded before ready
      ks.state = "ready";
      // §6.6/§7: the effective mode comes from the ACCEPTED ready response, never the
      // requested spec value — a fresh incarnation (first spawn or post-restart) re-seeds
      // it exactly as `preview-session.ts`'s single-incarnation facade does.
      const echoed = outcome.ready.body.interactionMode;
      if (echoed === "static" || echoed === "interactive") ks.interactionMode = echoed;
      emit({
        type: "ready",
        key: ks.key,
        sessionId: ks.sessionId,
        pageSlug: ks.spec.pageSlug,
        sourceHashPrefix: hashPrefix(ks.spec),
      });
    });
  }

  // The single decision point for a failed incarnation (a startup error OR a
  // post-`ready` onFatal). Guarded so one incarnation counts against the budget
  // exactly once. The real session already reaped its own child before onFatal;
  // the extra `stop()` is an idempotent safety net that also settles the fake.
  function onIncarnationFatal(ks: KeyState, error: ProtocolError | SupervisorError): void {
    if (ks.incarnationFailed || ks.closed) return;
    ks.incarnationFailed = true;
    const failed = ks.current;
    ks.current = null;
    void failed?.stop();
    const decision = policy.recordFailure(ks.key, error, clock.now());
    if (decision.action === "open") {
      ks.state = "circuit-open";
      emit({
        type: "circuitOpened",
        key: ks.key,
        sessionId: ks.sessionId,
        pageSlug: ks.spec.pageSlug,
        sourceHashPrefix: hashPrefix(ks.spec),
        attempts: decision.attempts,
        reason: decision.reason,
      });
      tryDrainQueue();
      return;
    }
    // A backing-off key KEEPS its host slot (see liveCount) and respawns into it,
    // so we do NOT drain the queue here — that would let a queued key take this
    // slot and push the global live count over the limit when this key respawns.
    ks.state = "backoff";
    emit({
      type: "backoff",
      key: ks.key,
      sessionId: ks.sessionId,
      pageSlug: ks.spec.pageSlug,
      sourceHashPrefix: hashPrefix(ks.spec),
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    });
    ks.backoffTimer = clock.setTimer(decision.delayMs, () => {
      ks.backoffTimer = null;
      startIncarnation(ks);
    });
  }

  // A freed live slot lets the oldest queued start proceed (§13). liveCount rises
  // as each queued key enters `starting`, so the loop self-limits.
  function tryDrainQueue(): void {
    while (startQueue.length > 0 && liveCount() < maxGlobalHosts) {
      const next = startQueue.shift();
      if (next === undefined) return;
      if (next.closed) continue;
      startIncarnation(next);
    }
  }

  /**
   * Blocker B4's composition point: a `SupervisedPreviewSession` — the UI-facing
   * `PreviewSession` shape (host-supervision §3.2) PLUS `state()` — built ONCE per key and
   * kept stable across restarts. `identity`/`frames`/`retry`/`close` are exactly what the
   * old `PreviewHandle` provided (survive automatic restart via the stable relay/sessionId).
   * `resize`/`setMode`/`query` are the part that did not exist before this decision: each
   * delegates to WHICHEVER incarnation is current (`ks.current`) at call time — read fresh
   * on every call, never captured once, so a restart transparently rebinds them to the new
   * incarnation. `interactionMode` reads `ks.interactionMode`, tracked by `startIncarnation`'s
   * ready hook using the SAME accepted-response-only rule `preview-session.ts` documents.
   */
  function sessionFor(ks: KeyState): SupervisedPreviewSession {
    if (ks.session !== null) return ks.session;
    const mode: "preview" | "historical" = ks.spec.mode === "historical" ? "historical" : "preview";
    const session: SupervisedPreviewSession = {
      get identity() {
        return {
          mode: ks.spec.mode,
          pageSlug: ks.spec.pageSlug,
          sourceHash: ks.spec.sourceHash,
          kitApiVersion: ks.spec.kitApiVersion,
          sessionId: ks.sessionId,
        };
      },
      get mode() {
        return mode;
      },
      get interactionMode() {
        return ks.interactionMode;
      },
      frames: ks.relay.frames,
      resize(size: Size) {
        const current = ks.current;
        if (current === null) {
          console.warn(
            `host-supervisor: resize(${ks.key}) dropped — no live incarnation (state "${ks.state}")`,
          );
          return;
        }
        // Fire-and-forget; a dropped error is LOGGED, never swallowed (errore rule 21).
        void current.resize(size).then((result) => {
          if (result instanceof Error)
            console.warn("host-supervisor: resize failed:", result.message);
        });
      },
      setMode(next: InteractionMode) {
        const current = ks.current;
        if (current === null) {
          console.warn(
            `host-supervisor: setMode(${ks.key}) dropped — no live incarnation (state "${ks.state}")`,
          );
          return;
        }
        void current.setMode(next).then((result) => {
          if (result instanceof Error) {
            console.warn("host-supervisor: set-mode failed:", result.message); // rejection/timeout/stale preserves the prior mode (§7)
            return;
          }
          if (result.body.interactionMode === next) ks.interactionMode = next;
        });
      },
      query(
        frameIdentity: FrameIdentity,
        query: GeometryQuery,
      ): Promise<ProtocolError | SupervisorError | GeometryQueryResult> {
        const current = ks.current;
        if (current === null) {
          return Promise.resolve(
            new SupervisorError({
              code: "TRANSPORT_ERROR",
              reason: `query(${ks.key}) has no live incarnation (state "${ks.state}")`,
            }),
          );
        }
        return current.query(frameIdentity, query);
      },
      state: () => ks.state,
      retry: () => retry(ks),
      close: () => close(ks),
    };
    ks.session = session;
    return session;
  }

  function retry(ks: KeyState): void {
    if (ks.closed) return;
    policy.retry(ks.key);
    if (ks.state !== "circuit-open" && ks.state !== "stopped") return;
    if (liveCount() >= maxGlobalHosts) {
      if (startQueue.length < startQueueCapacity && !startQueue.includes(ks)) {
        ks.state = "queued";
        startQueue.push(ks);
        return;
      }
      // Budget was already reset by policy.retry above, but there is no slot and no
      // queue room; the retry cannot proceed. Never silently drop (errore rule 21).
      console.warn(
        `host-supervisor: retry(${ks.key}) dropped — global host limit ${maxGlobalHosts} reached and start queue full`,
      );
      return;
    }
    startIncarnation(ks);
  }

  async function close(ks: KeyState): Promise<void> {
    if (ks.closed) return;
    ks.closed = true;
    ks.backoffTimer?.cancel();
    ks.backoffTimer = null;
    const queueIndex = startQueue.indexOf(ks);
    if (queueIndex >= 0) startQueue.splice(queueIndex, 1);
    const current = ks.current;
    ks.current = null;
    if (current !== null) await current.stop();
    await ks.pumpTask;
    ks.relay.close();
    ks.state = "stopped";
    emit({
      type: "stopped",
      key: ks.key,
      sessionId: ks.sessionId,
      pageSlug: ks.spec.pageSlug,
      sourceHashPrefix: hashPrefix(ks.spec),
    });
    tryDrainQueue();
  }

  function preview(spec: HostSessionSpec): SupervisedPreviewSession | SupervisorError {
    const trust = deps.checkTrust?.();
    if (trust instanceof SupervisorError) return trust;
    const key = keyOf(spec);
    const existing = keys.get(key);
    if (existing !== undefined && !existing.closed) {
      existing.spec = spec; // a size/theme/capability change keeps the key + budget (§10)
      return sessionFor(existing);
    }
    const ks: KeyState = {
      key,
      spec,
      sessionId: deps.mintSessionId(),
      relay: createPreviewRelay(),
      session: null,
      current: null,
      interactionMode: spec.interactionMode,
      incarnationFailed: false,
      backoffTimer: null,
      pumpTask: Promise.resolve(),
      state: "queued",
      closed: false,
    };
    keys.set(key, ks);
    if (liveCount() >= maxGlobalHosts) {
      if (startQueue.length >= startQueueCapacity) {
        keys.delete(key);
        return new SupervisorError({
          code: "HOST_CAPACITY",
          reason: `global host limit ${maxGlobalHosts} reached and start queue full (${startQueueCapacity})`,
        });
      }
      startQueue.push(ks);
      return sessionFor(ks);
    }
    startIncarnation(ks);
    return sessionFor(ks);
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...keys.values()].map((ks) => close(ks)));
  }

  return { preview, liveCount, stopAll };
}

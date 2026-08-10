import { log } from "infrastructure/debug-log";

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
import { createSparePool } from "./spare-pool";

const DEFAULT_MAX_GLOBAL_HOSTS = 10;
const DEFAULT_SPARE_CAPACITY = 1;
const DEFAULT_START_QUEUE_CAPACITY = 64;

/**
 * Per-key supervised session state. One `KeyState` lives for one logical `sessionId` and one
 * `treeRevision` — see {@link keyOf}, which owns the whole argument for why the tree's revision
 * and not the entry file's hash. It was `(pageSlug, treeRevision)` before design-tree phase 3
 * Task 5; the restart budget kept that shape instead — see {@link restartKeyOf}.
 */
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
  /**
   * A resize requested while no incarnation was ready yet (Task 11 —
   * resize-race-diagnosis.md): last-wins, flushed as a control request by
   * `startIncarnation`'s ready hook when THIS incarnation reaches ready.
   *
   * Teardown never replays it as a control request into a later incarnation (a stale
   * command could arrive out of order, and a not-yet-ready successor would just refuse
   * it anyway) — `pendingResize` itself is always `null` again before the next
   * `startIncarnation` runs. But `onIncarnationFatal` does not simply drop the
   * requested SIZE: it folds it into `ks.spec` first (fix round 2), so the successor
   * mounts at that size directly instead of the stale spec's. `close()` has no
   * successor to fold into, so it discards the size outright (logged, never silent).
   */
  pendingResize: Size | null;
  backoffTimer: TimerHandle | null;
  pumpTask: Promise<void>;
  state: SupervisorState;
  closed: boolean;
  /**
   * The slug this incarnation has actually mounted, or `null` before its first `ready` (design
   * §9.2, Task 5). The difference between this and `spec.pageSlug` is the whole switching
   * mechanism: `reconcileMount` closes it, and every path that reaches `ready` calls
   * `reconcileMount` rather than deciding for itself, so a switch requested while starting,
   * backing off or restarting cannot be lost.
   */
  mountedSlug: string | null;
  /**
   * True while a `reconcileMount`-issued `mount()` is in flight. `HostSession.mount()` itself
   * REFUSES a second concurrent call with a `TRANSPORT_ERROR` (`session.ts`'s own
   * `pendingMount !== null` guard) rather than queuing it — so without this flag, a THIRD page
   * requested while a switch to the SECOND is still in flight would make `reconcileMount` issue
   * a second `mount()` call, get back that refusal, and misread an ordinary scheduling
   * collision as an incarnation failure. Guarding here instead makes a mid-flight `preview()`
   * call a safe no-op: the in-flight mount's own completion handler calls `reconcileMount`
   * again and picks up whatever `ks.spec.pageSlug` is by then — last click still wins.
   */
  mounting: boolean;
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

  // THE SESSION KEY IS THE TREE REVISION ALONE (design-tree phase 3 Task 5, design §9.2: "an
  // incarnation is keyed by `treeRevision`"). It was `(pageSlug, treeRevision)` between phase 2
  // Task 10 and here — that change fixed WHICH edits re-establish a session; this one fixes WHAT
  // an incarnation IS: one process serves the whole tree revision and mounts one page at a time,
  // so two pages of the same revision now share one incarnation and a page switch is a `mount()`
  // on the live child, never a second spawn.
  //
  // M1 (plan Task 5, Step 6), MEASURED against a real `_host --stdio` child, Bun 1.3.14,
  // 2026-08-09, five runs each: wall-clock from `preview()` for the second page to a frame
  // carrying its source hash. Respawn (a different tree revision, the pre-Task-5 shape every
  // page switch used to take): 633-711ms, median 667.9ms. In-process mount (same revision,
  // this key): 65.3-67.3ms, median 65.9ms — roughly 10x faster, and the gap is dominated by the
  // respawn side's own boot cost (`timeouts.ts`'s handshake-budget doc: transpiling and loading
  // the whole application graph before the child's first statement), not by anything this key
  // change adds.
  const keyOf = (spec: HostSessionSpec) => spec.treeRevision;

  // THE RESTART KEY IS NOT THE SESSION KEY (design §9.2, last bullet). The crash-loop budget and
  // the circuit belong to (revision, the slug that was mounting when the failure occurred), so
  // one page looping does not spend the budget of every other page in the tree — with a
  // revision-keyed incarnation that would latch the circuit for the WHOLE design after three
  // failures of one page. `ks.spec.pageSlug` is that slug by construction: `preview` folds the
  // requested page into `ks.spec` before any mount is issued, and `startIncarnation` builds the
  // incarnation from it.
  const restartKeyOf = (ks: KeyState) => `${ks.spec.treeRevision} ${ks.spec.pageSlug}`;
  const hashPrefix = (spec: HostSessionSpec) => spec.sourceHash.slice(0, 8);
  const emit = (event: SupervisorEvent) => deps.onEvent?.(event);

  // Live = a key that owns a global host slot: starting, ready, OR backoff. A
  // backing-off key is a transient state of an ACTIVE session — it keeps its slot
  // and respawns into it, so a crash-loop can never hand its slot to a queued
  // session and then reclaim it, briefly exceeding the §13 ≤10 hard limit. Only
  // `queued`, `circuit-open`, and `stopped` free the slot.
  //
  // KEYED, NOT PUBLIC (design-tree phase 3 Task 6). This is the ADMISSION number — every
  // internal capacity check (`tryDrainQueue`, `retry`, `preview`) uses this, never the public
  // `liveCount()` below, because a held spare must not refuse a session it is about to become.
  const keyedLiveCount = () => {
    let live = 0;
    for (const ks of keys.values()) {
      if (ks.state === "starting" || ks.state === "ready" || ks.state === "backoff") live += 1;
    }
    return live;
  };

  const sparePool = createSparePool({
    spawn: deps.spawn,
    command: deps.spawnFor(null), // `null` = the spare's command, before any spec exists
    capacity: deps.spareCapacity ?? DEFAULT_SPARE_CAPACITY,
    canGrow: () => keyedLiveCount() + sparePool.size() < maxGlobalHosts,
  });

  // THE PUBLIC NUMBER IS PROCESSES, THE ADMISSION NUMBER IS KEYS, AND THEY MUST NOT BE THE SAME
  // FUNCTION (design §9.3: "total live incarnations stay under the existing global cap of 10").
  // A spare IS a live host process, so §13's cap has to see it. Admission may not, or a held
  // spare would refuse a session it is about to become: a new key always takes the spare before
  // spawning (`sessionDepsFor` below), so admitting at `keyed = 9, spares = 1` lands on
  // `keyed = 10, spares = 0` — still ten processes. Replenishment is what keeps that invariant
  // true, by only ever growing while `keyed + spares < maxGlobalHosts` (`sparePool`'s own
  // `canGrow` above).
  const liveCount = () => keyedLiveCount() + sparePool.size();

  function sessionDepsFor(ks: KeyState): HostSessionDeps {
    return {
      // ADOPTION (design §9.1): the spare is a child that already paid its own boot. It is
      // handed to the session in place of a fresh spawn; from `session.ts`'s point of view a
      // `SpawnFn` returned a child and nothing else is different. `deps.spawn` is the cold path
      // when the pool is empty.
      spawn: (command) => sparePool.take() ?? deps.spawn(command),
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

  // Task 11 (resize-race-diagnosis.md §6): flushes a resize buffered while no
  // incarnation was ready, through the SAME fire-and-forget dispatch the happy-path
  // `resize()` below uses — a flush failure is logged, never swallowed (errore rule 21).
  // Called ONLY from the ready hook, so it always runs against the incarnation that
  // just became ready.
  function flushPendingResize(ks: KeyState): void {
    const pending = ks.pendingResize;
    if (pending === null) return;
    const current = ks.current;
    // Guard BEFORE clearing the buffer (errore rule 21): nulling `pendingResize` first and
    // only then bailing here would silently drop the size on this defensive branch — nobody
    // would ever be told the incarnation was not actually ready, and the resize would simply
    // vanish. Checking first means a hit here (believed unreachable — ready implies current)
    // leaves the buffered size in place for a later flush instead of discarding it.
    if (current === null) return;
    ks.pendingResize = null;
    void current.resize(pending).then((result) => {
      if (result instanceof Error)
        log.warn("host-supervisor: buffered resize flush failed:", result.message);
    });
  }

  function startIncarnation(ks: KeyState): void {
    if (ks.closed) return;
    ks.incarnationFailed = false;
    ks.state = "starting";
    const attempt = policy.failureCount(restartKeyOf(ks), clock.now()) + 1;
    emit({
      type: "spawning",
      key: ks.key,
      sessionId: ks.sessionId,
      pageSlug: ks.spec.pageSlug,
      sourceHashPrefix: hashPrefix(ks.spec),
      attempt,
    });
    // Captured now, not read live off `ks.spec` in the ready hook below: `ks.spec` can move
    // again while this incarnation is still starting (a page switch requested while
    // negotiating/mounting), and `createSession` already closed over WHATEVER spec object THIS
    // call passes it — that is the page `start()` actually mounts, regardless of what `ks.spec`
    // says by the time `ready` arrives.
    const specAtSpawn = ks.spec;
    const session = createSession(specAtSpawn, sessionDepsFor(ks));
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
      // THE ONE PLACE `mountedSlug` IS SEEDED (design §9.2, Task 5). `start()` mounted whatever
      // page `specAtSpawn` named, which is not necessarily `ks.spec` any more — a switch
      // requested while this incarnation was still starting already moved `ks.spec` on. Seeding
      // from the SPAWN-time spec, then reconciling against the CURRENT one, is what makes a
      // switch requested before ready still take effect instead of being mistaken for a no-op.
      ks.mountedSlug = specAtSpawn.pageSlug;
      flushPendingResize(ks);
      reconcileMount(ks);
      // Replenish the spare AFTER this incarnation is actually consuming its own slot (design
      // §9.1's diagram: "frame → spare is replenished") — a spare exists only once something
      // is actually being previewed, never at rest before the first ever `preview()` call.
      sparePool.replenish();
    });
  }

  // Bring the live incarnation in line with `ks.spec` — the ONE place a page switch is issued
  // (design §9.2). Called from the ready hook (covering a switch requested while starting or
  // backing off) and from `preview` when the key is already ready. Fire-and-forget with a logged
  // failure routed into the ordinary fatal path (errore rule 21): a refused mount is an
  // incarnation failure, not a silent no-op, and `onIncarnationFatal` is what budgets and
  // reports it.
  function reconcileMount(ks: KeyState): void {
    if (ks.closed || ks.state !== "ready" || ks.mounting) return;
    if (ks.mountedSlug === ks.spec.pageSlug) return;
    const current = ks.current;
    if (current === null) return;
    const requested = ks.spec.pageSlug;
    ks.mounting = true;
    void current
      .mount({
        pageSlug: requested,
        entryRelPath: ks.spec.entryRelPath,
        sourceHash: ks.spec.sourceHash,
        kitApiVersion: ks.spec.kitApiVersion,
        size: ks.spec.size,
        interactionMode: ks.spec.interactionMode,
        theme: ks.spec.theme,
      })
      .then((result) => {
        // This incarnation was superseded (a fatal + respawn, or `close()`) while the mount
        // was in flight. `onIncarnationFatal`/`close` already reset `mounting`/`mountedSlug`
        // for whatever runs now, and teardown can easily outlast a 250ms backoff — a stale
        // reply here must never touch a LATER incarnation's state.
        if (ks.current !== current) return;
        ks.mounting = false;
        if (result instanceof Error) {
          // A REFUSAL THE INCARNATION SURVIVED IS NOT AN INCARNATION FAILURE (whole-branch
          // review, design-tree phase 3 Task 9). `current.phase` is still "ready" for a
          // PAGE-specific refusal `session.ts`'s own `mount()` never touched teardown for —
          // `checkKitApiVersion`'s client-side pre-check, or the child's typed `error` reply,
          // both returned WITHOUT calling `onPumpFatal`. Routing either into
          // `onIncarnationFatal` would kill a live process still correctly serving every
          // OTHER page sharing this incarnation, over one page's own static incompatibility —
          // exactly the blast-radius regression a revision-keyed incarnation must not have.
          // A genuinely fatal mount failure (MOUNT_TIMEOUT, a broken pipe) already moved
          // `phase` to "failed" inside `session.ts` before this promise settled, so that case
          // still falls through below unchanged.
          if (current.phase === "ready") {
            log.warn(
              `host-supervisor: mount(${requested}) refused, incarnation still alive:`,
              result.message,
            );
            return;
          }
          log.warn(`host-supervisor: mount(${requested}) failed:`, result.message);
          onIncarnationFatal(ks, result);
          return;
        }
        ks.mountedSlug = requested;
        // The spec may have moved again while this mount was in flight (two quick tab
        // clicks). Re-running the same reconciliation is what makes the last click win
        // without a queue: it is a no-op when nothing moved.
        reconcileMount(ks);
      });
  }

  // The single decision point for a failed incarnation (a startup error OR a
  // post-`ready` onFatal). Guarded so one incarnation counts against the budget
  // exactly once. The real session already reaped its own child before onFatal;
  // the extra `stop()` is an idempotent safety net that also settles the fake.
  function onIncarnationFatal(ks: KeyState, error: ProtocolError | SupervisorError): void {
    if (ks.incarnationFailed || ks.closed) return;
    ks.incarnationFailed = true;
    // Task 11 (fix round 2 — reviewer-confirmed gap): a resize buffered for the
    // incarnation that just died is NEVER replayed as a control request against
    // whatever starts next — that stays true, and is exactly what supervisor.test.ts's
    // "never replayed as a stale control request" test pins. But discarding the SIZE
    // outright reproduces this task's own defect one road over: the successor would
    // mount at the stale `ks.spec.size` (the "auto" 80x24 preset), and the shell's
    // per-(session,size) latch means nobody ever asks again. So the requested size is
    // folded into `ks.spec` — mount geometry, not a queued command — so the successor's
    // OWN mount request carries it directly. No round-trip, no reordering risk: it
    // travels as the spec the next incarnation is built from (`startIncarnation`'s
    // `createSession(ks.spec, ...)`), never as a resize sent after the fact.
    if (ks.pendingResize !== null) {
      ks.spec = { ...ks.spec, size: ks.pendingResize };
      ks.pendingResize = null;
    }
    const failed = ks.current;
    ks.current = null;
    ks.mountedSlug = null;
    ks.mounting = false;
    void failed?.stop();
    const decision = policy.recordFailure(restartKeyOf(ks), error, clock.now());
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
        failureCode: String(error.code),
        failureMessage: String(error.reason),
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

  // A freed live slot lets the oldest queued start proceed (§13). keyedLiveCount rises
  // as each queued key enters `starting`, so the loop self-limits.
  function tryDrainQueue(): void {
    while (startQueue.length > 0 && keyedLiveCount() < maxGlobalHosts) {
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
      resize(size: Size): Promise<SupervisorError | undefined> {
        // Task 11 (resize-race-diagnosis.md): a not-yet-ready incarnation refuses every
        // control request (session.ts's `sendRequest` phase gate), so calling into it
        // here would just be lost. Buffer instead — last-wins — and let the ready hook
        // flush it (host-supervision §8's coalescible-resize contract, cited at
        // deps.ts's shell-side comment). Buffering IS the accepted disposition, not a
        // failure: the caller asked for a size, and it WILL be applied once possible.
        if (ks.state !== "ready") {
          ks.pendingResize = size;
          return Promise.resolve(undefined);
        }
        const current = ks.current;
        if (current === null) {
          const reason = `resize(${ks.key}) dropped — no live incarnation (state "${ks.state}")`;
          log.warn(`host-supervisor: ${reason}`);
          return Promise.resolve(new SupervisorError({ code: "TRANSPORT_ERROR", reason }));
        }
        // A dropped error is LOGGED, never swallowed (errore rule 21), AND now returned
        // to the caller — `host-adapters/host-supervisor.ts` no longer has to fabricate
        // success for a resize that never reached the wire.
        return current.resize(size).then((result) => {
          if (!(result instanceof Error)) return undefined;
          log.warn("host-supervisor: resize failed:", result.message);
          return result instanceof SupervisorError
            ? result
            : new SupervisorError({
                code: "TRANSPORT_ERROR",
                reason: result.message,
                cause: result,
              });
        });
      },
      setMode(next: InteractionMode) {
        const current = ks.current;
        if (current === null) {
          log.warn(
            `host-supervisor: setMode(${ks.key}) dropped — no live incarnation (state "${ks.state}")`,
          );
          return;
        }
        void current.setMode(next).then((result) => {
          if (result instanceof Error) {
            log.warn("host-supervisor: set-mode failed:", result.message); // rejection/timeout/stale preserves the prior mode (§7)
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
    policy.retry(restartKeyOf(ks));
    if (ks.state !== "circuit-open" && ks.state !== "stopped") return;
    if (keyedLiveCount() >= maxGlobalHosts) {
      if (startQueue.length < startQueueCapacity && !startQueue.includes(ks)) {
        ks.state = "queued";
        startQueue.push(ks);
        return;
      }
      // Budget was already reset by policy.retry above, but there is no slot and no
      // queue room; the retry cannot proceed. Never silently drop (errore rule 21).
      log.warn(
        `host-supervisor: retry(${ks.key}) dropped — global host limit ${maxGlobalHosts} reached and start queue full`,
      );
      return;
    }
    startIncarnation(ks);
  }

  async function close(ks: KeyState): Promise<void> {
    if (ks.closed) return;
    ks.closed = true;
    // Task 11: unlike onIncarnationFatal, a closing key never mounts again, so a
    // buffered size has nowhere to fold to — discard it. But the Kernel already told
    // the caller this resize was accepted, so an abandoned value must leave a trace,
    // never vanish silently (errore rule 21).
    if (ks.pendingResize !== null) {
      log.warn(
        `host-supervisor: close(${ks.key}) dropped a buffered resize ` +
          `(${ks.pendingResize.w}x${ks.pendingResize.h}) — the session is closing`,
      );
      ks.pendingResize = null;
    }
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
    // A closed key is never reused: `preview()`'s own `!existing.closed` check already falls
    // through to a fresh KeyState for this same key, so nothing after this point ever reads
    // `keys.get(key)` expecting to find THIS entry. Deleting it is what stops the map growing
    // one dead entry per key ever used (design-tree phase 3 Task 9 review) — keyed on
    // `treeRevision` alone since Task 5, that would otherwise be one entry per commit for the
    // life of the process. Every `SupervisedPreviewSession` a caller still holds keeps working:
    // its closures reference `ks` directly, never through this map.
    //
    // THE IDENTITY CHECK IS LOAD-BEARING. `close()` awaits across several suspension points
    // above; a `preview()` call for the SAME key during one of those gaps already sees
    // `ks.closed === true` (set synchronously at the top of this function) and creates a FRESH
    // KeyState at this same map slot. Deleting unconditionally would evict that newer, live
    // entry instead of this stale one, making it unreachable by key — the next `preview()` for
    // the same key would spawn a duplicate incarnation the map no longer remembers to close.
    if (keys.get(ks.key) === ks) keys.delete(ks.key);
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
      reconcileMount(existing); // a PAGE change is a mount on the live child (§9.2)
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
      pendingResize: null,
      backoffTimer: null,
      pumpTask: Promise.resolve(),
      state: "queued",
      closed: false,
      mountedSlug: null,
      mounting: false,
    };
    keys.set(key, ks);
    if (keyedLiveCount() >= maxGlobalHosts) {
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
    sparePool.drain();
    await Promise.all([...keys.values()].map((ks) => close(ks)));
  }

  return { preview, liveCount, stopAll };
}

# Phase 2D-3 — Restart budget / backpressure / HostSupervisor Implementation Plan

> **For agentic workers:** Load `/reatom` and `/errore` before touching code
> (CLAUDE.md mandate). Execute task-by-task with TDD (failing test → run red →
> implement → run green → commit). Steps use checkbox (`- [ ]`) syntax. Keep
> `bun test` + `bun x tsc --noEmit` green after every task, and `bun test` must
> return to the shell (no hang).

**Goal:** Turn the single-shot 2D-1/2D-2 session (drives ONE incarnation to
`ready`, then `onFatal` on a post-ready failure) into a **crash-loop-safe**
supervisor: a per-`(pageSlug, sourceHash)` restart budget + deterministic base-2
backoff + circuit breaker (§10); a bounded ordered outbound control queue with
coalescing + `HOST_BACKPRESSURED`/`preview.writable` (§8); a bounded inbound
control mailbox → `CONTROL_BACKPRESSURE` (§8); rolling-second flood detection
(`PROTOCOL_FLOOD`/`STDERR_FLOOD`, §8); and the `HostSupervisor` object that owns
multiple sessions, enforces the ≤10 global host limit + 64-deep `HOST_CAPACITY`
start queue (§13), and drives the restart state machine.

**Architecture:** The 2D-1 `createHostSession` stays the single-incarnation
driver (`spawn → ready → onFatal`). 2D-3 wraps it: `HostSupervisor` creates one
`HostSession` incarnation per attempt, keyed by `(pageSlug, sourceHash)`, with a
**stable `sessionId`** (passed via `deps.sessionId`) and a **fresh `nonce`** per
incarnation (minted inside `createHostSession`). It wires each incarnation's
`onFatal` into a pure `RestartPolicy` decision engine: budgeted failure → close
the old incarnation (§10.1), wait the backoff, respawn; deterministic/hostile
failure or exhausted budget → open the circuit (emit exactly one
`preview.circuitOpened`), no background spawns. All lifecycle transitions are
serialized per key through the supervisor actor so two children are never live
for one session. Pure decision components (`restart-policy`, `control-queue`,
`flood-monitor`, `control-mailbox`) are standalone + fully unit-tested, then
composed by the supervisor.

**Tech Stack:** Bun (`bun test`, `bun x tsc --noEmit`), TypeScript 7 (`strict`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `errore` (errors as values),
the injected `Clock`/`ManualClock` seam, the 2A codecs, and the 2D-1/2D-2
session + broker + request table + watchdog. Non-Reatom (closure driver + pure
decision engines); no atoms.

## Global constraints

Inherits the roadmap + phase-2 index + 2D master-index Global constraints by
reference. 2D-3-critical:

- **errore everywhere:** namespace import; errors as values
  (`SupervisorError | ProtocolError | T`); one-line `instanceof Error` early
  returns; flat control flow; never a silent swallow (log any dropped error).
- **Closed error vocabulary:** every 2D-3 code
  (`HOST_BACKPRESSURED`/`TOO_MANY_REQUESTS`/`CONTROL_BACKPRESSURE`/
  `PROTOCOL_FLOOD`/`STDERR_FLOOD`/`HOST_CAPACITY`/`CIRCUIT_OPEN`) already exists
  in the 2D-1 `SupervisorErrorCode` union (`errors.ts`). Add NO new error type.
- **Supervisor-owned lifetimes:** every timer (backoff, flood window), the child
  process handle, the frame iterator, and the start queue are owned by
  supervisor closures with explicit teardown on every exit path — never a Reatom
  connect hook.
- **§10.1 stale teardown:** on restart, close the old incarnation's parser +
  frame publisher (its `HostSession.stop()`/broker close) BEFORE creating the new
  incarnation's `nonce`. Old-process bytes stay bound to the closed decoder.
- **All durations monotonic:** injected `Clock`; every timeout/window uses it;
  deterministic under `ManualClock`.
- **`ManualClock` for every timer test.** Real-microtask races stabilized with
  the existing `waitUntil(predicate, label)` pattern, never a fixed tick count.

## Decisions

1. **Classification is by error type, not a code list where possible.** All 7
   `ProtocolViolationCode` values are schema/negotiation/identity/kit/source-hash
   failures — every `ProtocolError` is deterministic/hostile ⇒ open immediately.
   `SupervisorError` codes `PROTOCOL_FLOOD`/`STDERR_FLOOD`/`CONTROL_BACKPRESSURE`
   are also deterministic (a restart cannot fix a flooding child or a stalled
   consumer). Every other `SupervisorError` (`CHILD_EXITED`, `TRANSPORT_ERROR`
   broken pipe, `HEARTBEAT_TIMEOUT`, `QUERY_TIMEOUT` unresponsive-escalation,
   `SPAWN_FAILED`, `HANDSHAKE_TIMEOUT`, `MOUNT_TIMEOUT`, `DESIGN_RENDER_FAILED`,
   `SHUTDOWN_TIMEOUT`, `REAP_TIMEOUT`) is **budgeted**.

2. **"60s continuous ready clears history" = rolling-60s-window prune.** The
   budget counts only failures with timestamp ≥ `now − 60_000`; a child that
   stays `ready` 60s ages all prior failures out of the window, which is exactly
   the spec's clear. `RestartPolicy` is a pure function of `(key, error, now)` —
   no background timer, fully deterministic. `noteReady` is unnecessary for the
   budget and is omitted (documented).

3. **The supervisor wraps, never rewrites, `createHostSession`.** Each attempt is
   a fresh `createHostSession(spec, {...deps, sessionId, onFatal})`. The stable
   `sessionId` is minted once per key by the supervisor; a fresh `nonce` is minted
   per incarnation inside `createHostSession` (unchanged). This keeps the 2D-1/2D-2
   driver untouched and the single-incarnation invariants intact.

4. **`control-queue` / `flood-monitor` / `control-mailbox` are built + fully
   unit-tested as standalone components in this slice, and composed by the
   supervisor where the composition is clean.** The outbound control queue is
   owned by the supervisor's per-session command path; the flood monitor observes
   the incarnation's decoded frames + stderr bytes via callbacks the supervisor
   already receives (`onFrame`, stderr drain); the inbound mailbox bounds
   `onControlEvent`. Each is wired through an injected seam so the wiring is
   test-observable and not half-built.

## File Structure

| File | Responsibility | New? | Task |
|---|---|---|---|
| `src/host/supervisor/model/restart-policy.ts` | pure budget + base-2 backoff + circuit + classification per key | create | T1 |
| `src/host/supervisor/model/restart-policy.test.ts` | policy unit suite | create | T1 |
| `src/host/supervisor/model/control-queue.ts` | bounded ordered outbound queue (256+1 shutdown slot), coalescing, `HOST_BACKPRESSURED`, `preview.writable` low-water 128 | create | T2 |
| `src/host/supervisor/model/control-queue.test.ts` | queue unit suite | create | T2 |
| `src/host/supervisor/model/flood-monitor.ts` | rolling-second `PROTOCOL_FLOOD` (>1000 frames or >128 MiB) / `STDERR_FLOOD` (>1 MiB) | create | T3 |
| `src/host/supervisor/model/flood-monitor.test.ts` | flood unit suite | create | T3 |
| `src/host/supervisor/model/control-mailbox.ts` | bounded inbound control mailbox (256+1 terminal slot) → `CONTROL_BACKPRESSURE` | create | T3 |
| `src/host/supervisor/model/control-mailbox.test.ts` | mailbox unit suite | create | T3 |
| `src/host/supervisor/model/supervisor.ts` | `HostSupervisor`: per-key sessions, restart orchestration (§10/§10.1), ≤10 global + 64 `HOST_CAPACITY` queue, manual retry, source-change new key, lifecycle-event sink | create | T4 |
| `src/host/supervisor/model/supervisor.test.ts` | supervisor integration suite (scripted crashing children + `ManualClock`) | create | T4 |
| `src/host/supervisor/types.ts` | + `RestartPolicy`/`RestartAction`, `ControlQueue`, `FloodMonitor`, `ControlMailbox`, `HostSupervisor`, `SupervisorEvent` interfaces; grow `HostSupervisorDeps` | modify | T1–T4 |
| `src/host/supervisor/index.ts` | re-export the new factories + types | modify | T1–T4 |
| `.superpowers/sdd/progress.md` | ledger entries | modify | each |

## Task 1 — `restart-policy.ts` (pure budget + backoff + circuit)

Pure, no I/O, no clock object — `now` is a parameter. The heart of "crash-loop
safe."

**Produces:**
- `RESTART_WINDOW_MS = 60_000`, `MAX_AUTOMATIC_RESTARTS = 3`, `BACKOFF_BASE_MS = 250`
- `type RestartAction = { action: "restart"; delayMs: number; attempt: number } | { action: "open"; attempts: number; reason: string }`
- `interface RestartPolicy { recordFailure(key, error, now): RestartAction; isOpen(key): boolean; retry(key): void; failureCount(key, now): number }`
- `function createRestartPolicy(opts?): RestartPolicy`
- `function classifyFailure(error): "budgeted" | "deterministic"` (exported for the supervisor + tests)

**Behaviour (§10):**
- classify: `ProtocolError` → deterministic; `SupervisorError` in
  {`PROTOCOL_FLOOD`,`STDERR_FLOOD`,`CONTROL_BACKPRESSURE`} → deterministic; else budgeted.
- `recordFailure`: if already open → `{action:"open"}` idempotent. Prune window
  (< now−60s). Push this failure. deterministic ⇒ open now. count ≥ 4 ⇒ open
  (budget exhausted). else restart delay `250·2^(count−1)` (250/500/1000),
  attempt = count.
- open latches: `isOpen(key)` stays true until `retry(key)` clears history +
  closes the circuit once.

Tests: 1st/2nd/3rd budgeted failure → restart 250/500/1000 attempt 1/2/3; 4th →
open (attempts 4); a deterministic `ProtocolError` on failure 1 → open
immediately; flood `SupervisorError` → open immediately; window prune (a failure
> 60s after the prior resets the count → restart 250 again); `retry` closes an
open circuit + resets count once; `isOpen` false before any failure;
`classifyFailure` covers each branch.

## Task 2 — `control-queue.ts` (bounded ordered outbound queue)

Pure structure. FIFO of discrete commands + a single coalescible pending slot per
coalescible kind; 256 discrete capacity + 1 reserved shutdown slot; low-water 128.

**Produces:**
- `OUTBOUND_QUEUE_CAPACITY = 256`, `OUTBOUND_LOW_WATER = 128`
- `interface ControlQueue { enqueue(cmd): "accepted" | SupervisorError; enqueueShutdown(cmd): "accepted"; coalesce(kind, cmd): "accepted"; dequeue(): QueuedCommand | null; size(): number; onWritable(cb): void }`
- `function createControlQueue(opts?): ControlQueue`

**Behaviour (§8):** discrete `enqueue` past 256 → `HOST_BACKPRESSURED` (never drop
an accepted entry, never reorder); `coalesce(resize|mousemove|hover)` replaces a
pending value even when full, never creates a new discrete entry; `enqueueShutdown`
always accepted via the reserved slot; draining below 128 fires `onWritable`
(`preview.writable`) exactly once per high→low crossing.

Tests: fill 256, next discrete → `HOST_BACKPRESSURED`, order preserved on drain;
coalesce while full replaces (one entry, latest value); shutdown accepted when
full; `onWritable` fires once crossing 256→128, not again until refilled past the
mark; FIFO discrete ordering.

## Task 3 — `flood-monitor.ts` + `control-mailbox.ts`

**`flood-monitor`** (rolling-second counters on the injected `Clock`):
`noteFrame(byteLength)` → `PROTOCOL_FLOOD` when > 1000 frames OR > 128 MiB in the
rolling second; `noteStderr(byteLength)` → `STDERR_FLOOD` when > 1 MiB/rolling
second. Returns `SupervisorError | null` per note (fatal ⇒ supervisor kills +
opens the circuit). Tests: 1000 frames OK, 1001st → flood; 128 MiB boundary; a
burst that ages out of the window does not trip; stderr 1 MiB boundary.

**`control-mailbox`** (bounded inbound): 256 + 1 reserved terminal slot; `offer`
past 256 → `CONTROL_BACKPRESSURE` (supervisor kills, uses the terminal slot for
the failure event). Tests: 256 accepted, 257th → `CONTROL_BACKPRESSURE`; drain
frees slots; terminal slot always accepts the failure event.

## Task 4 — `HostSupervisor` (`supervisor.ts`) integration

The integration piece. Owns a `Map<key, KeyState>`; per key a stable `sessionId`,
the `RestartPolicy`, the current `HostSession` incarnation, a backoff timer, and
the outbound queue/flood/mailbox composition. Serializes all lifecycle calls per
key.

**Produces:**
- `interface SupervisorEvent` (lifecycle: `spawning`/`ready`/`backoff`/`circuitOpened`/`stopped`, each tagged by `sessionId`+key, bounded diagnostic fields §13)
- `interface HostSupervisorDeps { spawnFor(spec): SpawnCommand; clock; runtimeDeclaration; mintSessionId(): string; onEvent?(e): void; checkTrust?(): SupervisorError | null; createSession?: typeof createHostSession }`
- `interface HostSupervisor { preview(spec): HostSession | SupervisorError; retry(key): void; stopAll(): Promise<void>; liveCount(): number }`
- `function createHostSupervisor(deps): HostSupervisor`

**Behaviour (§10/§10.1/§13):**
- `preview(spec)`: trust check; ≤10 global live hosts else enqueue in the 64-deep
  start queue else `HOST_CAPACITY`; mint (or reuse) the key's stable `sessionId`;
  create + start the incarnation; wire `onFatal`.
- `onFatal(error)`: `restartPolicy.recordFailure(key, error, now)` → `restart`:
  close the old incarnation (§10.1), set backoff timer, on fire respawn a fresh
  incarnation (same sessionId, new nonce); `open`: emit exactly one
  `circuitOpened{attempts, reason}`, no respawn.
- `retry(key)`: `restartPolicy.retry(key)`, start a fresh incarnation (same
  sessionId, new nonce) if currently open/stopped.
- source change: a spec with a different `sourceHash`/`pageSlug` is a new key →
  fresh `sessionId` + fresh budget. theme/size/capability changes keep the key.
- global limit: `liveCount()` counts non-stopped incarnations; a `preview` past
  10 waits in the 64 queue; past 64 → `HOST_CAPACITY`.
- `stopAll()`: stop every incarnation, cancel every backoff timer, no hang.

Tests (§14.2/§14.4): crash 4 incarnations for one key ⇒ 250/500/1000 backoff
(ManualClock advances) + exactly one `circuitOpened` + no 5th spawn; a
deterministic `ProtocolError` on incarnation 1 ⇒ immediate open, no backoff; a
manual `retry` after open starts one fresh incarnation + resets the budget; a
source change gets a new `sessionId`/key with a fresh budget; size/theme change
keeps the key/budget; `HOST_CAPACITY` past the global limit; `stopAll` returns to
the shell with `clock.pending()===0`.

## Deferred (NOT built in 2D-3 — 2D-4/phase-6)

- One-shot `smoke`/`export` sessions + export pool (2D-4).
- Geometry queries, bulk `capture`/`layout`, `FrameToken`/`GeometryToken`.
- Input forwarding, `set-tweak`, `set-theme`/`set-capabilities`,
  `navigation`/`runtime-warning`/`done` (the 2C child neither accepts nor emits).
- Kernel Command/Result/Event DTOs + capability publication (phase 6) — 2D-3
  exposes the standalone `HostSupervisor` + `SupervisorEvent` sink; phase 6 wires
  it onto the Kernel event channel.
- Trust ledger, `SafeProjectFs`, projections/diagnostics store (phase 4) — 2D-3
  takes an injected `checkTrust()` + `onEvent` sink with test doubles.

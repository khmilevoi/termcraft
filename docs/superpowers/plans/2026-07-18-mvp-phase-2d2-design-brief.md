# Phase 2D-2 — Broker / PreviewSession — Design Brief & Decomposition

> **Status:** DESIGN BRIEF (brainstorm output), NOT yet the executable TDD plan.
> It resolves the one hard architectural decision 2D-2 carries (the post-`ready`
> inbound pump vs. the 2D-1 session's iterator ownership), locks the module
> boundaries and interfaces, and maps every in-scope spec row to a task. The full
> task-by-task TDD plan (`2026-07-18-mvp-phase-2d2-broker-preview.md`) is written
> from this brief with superpowers:writing-plans, then goes through the ultracode
> adversarial plan-review, then executes with superpowers:subagent-driven-development.
> Load `/reatom` and `/errore` before touching code (CLAUDE.md mandate).

**Goal:** Turn a single-shot supervisor session (2D-1 drives ONE incarnation to
`ready` then stops) into a *live* preview session: a capacity-1 latest-wins frame
broker with §10.1 stale guards, the `PreviewSession` facade subset the 2C child
actually supports, a 64-entry request table (2s `QUERY_TIMEOUT`, `SUPERSEDED`,
`TOO_MANY_REQUESTS`), and a heartbeat/liveness watchdog (5s `HEARTBEAT_TIMEOUT`;
3 request timeouts in 10s ⇒ unresponsive). Primary spec:
`docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` §3.2, §7,
§8 (broker/request/mailbox rows), §9, §10.1.

**Depends on:** 2D-1 (`969f59c..3defd21`). Consumes its transport (`readInbound`,
`writeFramed`, `createStderrDrain`), handshake, session state machine, injected
`Clock`, `SupervisorError` family, and 2A codecs.

---

## 1. The one hard decision: the post-`ready` pump

### Problem

2D-1's `HostSession` (`src/host/supervisor/model/session.ts`) reads the inbound
iterator ONLY inside `start()` (`awaitReady`) and `stop()` (`awaitShutdownAck`).
Between `ready` and `stop` **nothing reads inbound** — post-`ready` frames,
heartbeats, and request responses are never consumed. `onFrame`/`onControlEvent`
(`HostSessionDeps`) exist and are called for the FIRST frame during `awaitReady`
and during `awaitShutdownAck`, but there is no continuous post-`ready` loop. So:

- The heartbeat watchdog cannot work — nothing feeds it heartbeats.
- Request/response correlation (`resize`/`set-mode`/`ping`) has no reader.
- The frame broker would receive only the single startup frame.

2D-2 must add a continuous post-`ready` **pump**. The design question is how it
coexists with the session's single-owner inbound iterator — the 2D-1 review
already flagged the hazard that a second concurrent `nextInbound` pull corrupts
the stream (the abandoned-pull note in `session.ts:62-67`).

### Options considered

- **A — single-reader actor pump inside the session (CHOSEN).** After `ready`, the
  session runs ONE pump loop that is the sole reader of the inbound iterator for
  the whole `ready → stopped` lifetime. Every post-`ready` inbound message flows
  through it. `stop()` no longer reads inbound directly: it sends a correlated
  `shutdown` through the request table and awaits the pump's resolution of the
  `shutdown-ack`. This UNIFIES reading under one loop and permanently closes the
  concurrent-`nextInbound` hazard. Cost: a real refactor of `session.ts`
  `stop()`/`awaitShutdownAck` into the pump, so this task needs a de-risking probe
  and the adversarial review.
- **B — separate 2D-2 driver reusing only transport primitives.** Rebuilds
  lifecycle on top of `readInbound`/`writeFramed`/handshake, bypassing
  `createHostSession`. Rejected: duplicates the reviewed lifecycle (DRY/2C-audit
  regression risk).
- **C — session hands the iterator to a 2D-2-owned pump after `ready`.** Keeps
  `session.ts` intact but exposes the private iterator and splits stop ownership
  across two modules. Rejected: two owners of one terminating resource is exactly
  the teardown hazard the roadmap hardening rule forbids.

### Chosen invariants (Option A)

1. **One reader.** From `ready` onward the pump is the ONLY caller of
   `inbound.next()`. `start()`'s `awaitReady` hands the iterator to the pump at the
   `ready` transition; `stop()` never pulls inbound itself.
2. **Correlation through the request table.** `stop()` registers a `shutdown`
   request and `await`s it; `resize`/`set-mode`/`ping` do the same. The pump routes
   any envelope carrying `responseTo` to `requestTable.resolve(responseTo, env)`.
3. **Liveness is independent of reads.** The heartbeat watchdog owns the 5s bound
   on its own `Clock` timer; a heartbeat message feeds it, but silence trips it
   without needing a read. `HEARTBEAT_TIMEOUT` (and 3-timeouts-in-10s unresponsive)
   trigger the same fatal teardown path `failWith` already implements.
4. **Frames never block the loop.** The pump hands each data frame to the broker
   with a non-awaiting atomic replace (§8) and moves on; a stalled consumer cannot
   stall lifecycle.
5. **Teardown still supervisor-owned.** The pump loop, its watchdog timer, the
   broker iterator, and the request-table timers are all torn down on every exit
   path (crash, `HEARTBEAT_TIMEOUT`, protocol error, graceful/forced stop) — never
   a Reatom connect hook.
6. **Restart edges stay 2D-3.** The pump's fatal outcomes (`HEARTBEAT_TIMEOUT`,
   crash, unresponsive, protocol error) set `phase="failed"` and terminate the
   incarnation; the restart budget/backoff/circuit that CONSUMES those outcomes is
   2D-3. 2D-2 exposes them as typed results/events, it does not restart.

---

## 2. Module boundaries (CLAUDE.md shape: code in `model/`, `types.ts`/`index.ts` at root)

| File | Responsibility | New? |
|---|---|---|
| `src/host/types.ts` | + `PreviewFrame` (immutable displayed frame value, §3.2/§5.3), `PreviewIdentity = Omit<HostSessionIdentity,"nonce">`, `PreviewLifecycleEvent` union | modify |
| `src/host/supervisor/model/frame-broker.ts` | capacity-1 latest-wins broker; §10.1 stale guard (session+nonce+sourceHash+monotonic `frameSeq`); `framesCoalesced`; `frames` AsyncIterable of `PreviewFrame`; `close()` ends the iterator | create |
| `src/host/supervisor/model/request-table.ts` | 64-entry outstanding request table; `register` → `TOO_MANY_REQUESTS` when full; 2s `QUERY_TIMEOUT` via `Clock`; `resolve(responseTo)`; `supersede(id)` → `SUPERSEDED`; `clear()` on teardown; `onTimeout` callback feeds the watchdog | create |
| `src/host/supervisor/model/heartbeat-watchdog.ts` | 5s no-valid-heartbeat → `HEARTBEAT_TIMEOUT`; 3 request timeouts in rolling 10s → unresponsive; `feedHeartbeat`/`noteRequestTimeout`/`start`/`stop`; fires an injected `onUnhealthy(SupervisorError)` | create |
| `src/host/supervisor/model/session.ts` | **refactor**: add the post-`ready` pump (single reader) dispatching data→broker, `responseTo`→request table, heartbeat→watchdog, others→`onControlEvent`; refactor `stop()` to correlate `shutdown-ack` through the request table; add `resize`/`setMode`/`ping` request senders | modify |
| `src/host/supervisor/model/preview-session.ts` | `PreviewSession` facade SUBSET: `identity` (sans nonce), `mode`, `frames` (broker iterable), `resize`, `setMode`, `retry` (stub → 2D-3 restart), `close`; typed adapters over the session's request senders | create |
| `src/host/supervisor/types.ts` | + broker/request-table/watchdog/preview-session interfaces; grow `HostSessionDeps` with broker/requestTable/watchdog seams (default-constructed) | modify |
| `src/host/supervisor/index.ts` | re-export `createPreviewSession`, `PreviewFrame`, broker/request-table types | modify |

**Deferred to 2D-3/2D-4/later (do NOT half-build):** the ordered outbound control
queue (256+1) + `HOST_BACKPRESSURED`/`preview.writable`; the inbound control
mailbox bound (256+1) + `CONTROL_BACKPRESSURE`; flood detection
(`PROTOCOL_FLOOD`/`STDERR_FLOOD`); the restart budget/backoff/circuit +
`HostSupervisor`; `forwardInput`/`setTweak`/`setTheme`/`setCapabilities`/geometry
`query`/`FrameToken`/`GeometryToken` (the 2C child neither accepts nor emits them —
§3.2 facade methods for these are NOT built; `retry` is a stub until 2D-3).

---

## 3. Interfaces (pinned; the full plan turns each into TDD tasks)

```ts
// src/host/types.ts  (import type { StyledRun } from "./protocol" — type-only, erased)
export interface PreviewFrame {
  readonly sessionId: string   // facade identity; nonce intentionally omitted (§3.2)
  readonly sourceHash: string
  readonly frameSeq: string
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}
export type PreviewIdentity = Omit<HostSessionIdentity, "nonce">

// src/host/supervisor/model/frame-broker.ts
export interface FrameBroker {
  /** Atomic capacity-1 replace. Rejects a frame failing the §10.1 identity/seq guard. */
  publish(frame: FrameEnvelope): "accepted" | "stale"
  readonly frames: AsyncIterable<PreviewFrame>
  framesCoalesced(): number
  close(): void
}
export function createFrameBroker(guard: {
  sessionId: string; nonce: string; sourceHash: string
}): FrameBroker

// src/host/supervisor/model/request-table.ts
export interface RequestTable {
  /** Reserve a correlation id; resolves on resolve()/supersede()/2s QUERY_TIMEOUT. */
  register(requestId: string, kind: string): Promise<ControlEnvelope | SupervisorError>
  resolve(responseTo: string, envelope: ControlEnvelope): void
  supersede(requestId: string, reason: string): void
  size(): number
  clear(): void
}
export function createRequestTable(
  clock: Clock,
  opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number },
): RequestTable

// src/host/supervisor/model/heartbeat-watchdog.ts
export interface HeartbeatWatchdog {
  start(): void
  feedHeartbeat(): void
  noteRequestTimeout(): void
  stop(): void
}
export function createHeartbeatWatchdog(
  clock: Clock,
  opts: { onUnhealthy: (error: SupervisorError) => void },
): HeartbeatWatchdog

// src/host/supervisor/model/preview-session.ts (facade subset)
export interface PreviewSession {
  readonly identity: PreviewIdentity
  readonly mode: "preview" | "historical"
  readonly frames: AsyncIterable<PreviewFrame>
  resize(size: Size): void
  setMode(mode: InteractionMode): void
  retry(): void          // 2D-2 stub; real restart lands in 2D-3
  close(): Promise<void>
}
export function createPreviewSession(
  spec: HostSessionSpec,
  deps: HostSessionDeps,
): PreviewSession   // internally owns a HostSession + broker + request table + watchdog
```

New `SupervisorErrorCode`s consumed here already exist in the 2D-1 closed union:
`QUERY_TIMEOUT`, `HEARTBEAT_TIMEOUT`, `SUPERSEDED`, `TOO_MANY_REQUESTS` (declared
in `errors.ts` for exactly this slice). No new error type is added.

---

## 4. Spec-row → task map (coverage check before writing the full plan)

| Spec row | Where | Task |
|---|---|---|
| §8 Preview frame broker = 1 complete frame; atomic replace; `framesCoalesced++` | frame-broker | T1 |
| §10.1 broker compares session, nonce, sourceHash, monotonic `frameSeq` before replace | frame-broker | T1 |
| §10.1 closing/superseding a PreviewSession closes its frame iterator | frame-broker + preview-session | T1, T5 |
| §3.2 `PreviewFrame` immutable value; `identity` sans nonce | host/types + preview-session | T1, T5 |
| §8 outstanding request table = 64; `TOO_MANY_REQUESTS` before send | request-table | T2 |
| §9 geometry/ordinary request 2s → `QUERY_TIMEOUT`; late responses discarded | request-table | T2 |
| §7 replaced hover query → local `SUPERSEDED`; every request has ONE terminal outcome | request-table | T2 |
| §9 5s since last valid heartbeat → `HEARTBEAT_TIMEOUT` even if frames arrive | watchdog | T3 |
| §9 3 request timeouts in 10s → unresponsive → restart path (signal only; act in 2D-3) | watchdog | T3 |
| §7 `set-mode` correlated non-coalescible; mode atoms change only on accepted response | session pump + preview-session | T4, T5 |
| §6/§8 the pump: one reader; frames non-blocking; controls correlated | session refactor | T4 |
| §3.2 facade subset (`resize`/`setMode`/`retry`/`close`, frames, identity) | preview-session | T5 |

**§14 test mapping (from the master index):** slow-consumer bounded broker
(240 fps producer, blocked consumer ⇒ latest-wins + bounded memory + lifecycle
still flows); stale old-nonce frame rejected at the broker after a nonce change;
a delayed `set-mode` response completes exactly once; mode flag changes only on an
accepted matching response; heartbeat-timeout kills.

---

## 5. Proposed task sequence (each ends green: `bun test` + `bun x tsc --noEmit`)

1. **T1 — `PreviewFrame` + frame broker.** Pure, standalone. TDD: accept→yield;
   capacity-1 latest-wins coalesce count; stale by nonce/sessionId/sourceHash;
   non-monotonic `frameSeq` rejected; `close()` ends the iterator; slow-consumer
   memory bound (240 pushes, 1 pending).
2. **T2 — request table.** Uses `Clock` + `ManualClock`. TDD: register/resolve
   round-trip; 2s `QUERY_TIMEOUT` removes + resolves once; `supersede` →
   `SUPERSEDED`; 65th register → `TOO_MANY_REQUESTS`; late resolve after timeout is
   a no-op; `onTimeout` fires.
3. **T3 — heartbeat watchdog.** Uses `Clock`. TDD: 5s silence → `onUnhealthy`
   `HEARTBEAT_TIMEOUT`; `feedHeartbeat` resets; frames do NOT reset; 3
   `noteRequestTimeout` in 10s → unresponsive; `stop()` cancels timers (no hang).
4. **T4 — session post-`ready` pump + stop refactor.** Modify `session.ts`. TDD
   against the scripted child: post-`ready` frames reach an injected broker;
   heartbeats feed the watchdog; a correlated `resize`/`ping` resolves; `stop()`
   correlates `shutdown-ack` through the request table (graceful + forced still
   pass); `HEARTBEAT_TIMEOUT` tears down to `failed`. **Needs a de-risking probe
   first** (single-reader handoff vs. the abandoned-pull hazard) — this is the
   task most likely to bake in a wrong assumption.
5. **T5 — `PreviewSession` facade.** Wires session+broker+request-table+watchdog.
   TDD: `frames` streams broker output; `resize`/`setMode` dispatch correlated
   requests; `setMode` mode change only on accepted response (§7); `close()`
   stops the session AND closes the frame iterator; `identity` omits nonce.
6. **T6 — gate + ledger + arch-doc note + adversarial whole-slice review.** Full
   `bun test` + tsc; update `.superpowers/sdd/progress.md`; run the ultracode
   adversarial multi-lens review (as 2D-1 did) before declaring 2D-2 done.

---

## 6. Open questions for the full plan / de-risking (resolve before TDD detail)

1. **Pump vs. `nextInbound`.** Does the pump call `inbound.next()` in a bare
   `for await` (no per-message timeout; the watchdog owns liveness), or keep a
   long deadline? Probe: confirm a `for await (const m of inbound)` loop with a
   concurrent watchdog timer tears down cleanly on `HEARTBEAT_TIMEOUT` without
   leaking the suspended `next()` (mirror the 2D-1 `inbound.return()` teardown).
2. **`ready`→pump handoff.** `awaitReady` currently consumes the first frame. Does
   the pump start exactly at the `ready` transition, and does the already-captured
   `firstFrame` get published to the broker (so the first displayed frame is not
   dropped)? Decision leaning: publish `firstFrame` to the broker at pump start.
3. **`stop()` via request table.** Confirm the 1s `shutdown-ack` deadline (§9) is
   enforced by the request table's own timeout or a dedicated stop timer, and the
   forced-kill path still reaps within 1s (2D-1 `reapChild`).
4. **PreviewFrame import cycle.** `host/types.ts` referencing `StyledRun` from
   `./protocol` is a type-only cycle (erased) — confirm tsc is clean, else move
   `PreviewFrame` to `supervisor/types.ts`.

---

## 7. Handoff

This brief is the design pass. Next: (1) write
`2026-07-18-mvp-phase-2d2-broker-preview.md` from §3–§5 with full TDD code per
step (superpowers:writing-plans), (2) run the ultracode adversarial plan-review
and apply confirmed findings, (3) run the T4 de-risking probe, (4) execute with
superpowers:subagent-driven-development, (5) close with the T6 whole-slice review.
Recommended to start the heavy multi-agent steps on a fresh session budget.

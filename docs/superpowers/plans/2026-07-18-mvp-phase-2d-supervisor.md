# termcraft MVP Phase 2D — HostSupervisor / PreviewSession (master index)

> **For agentic workers:** This is the 2D master index, not an executable task
> plan. 2D is large (the single most complex slice of phase 2 — real process
> spawning, framed stdio, bounded queues, timeouts, a restart/circuit-breaker
> state machine, and stale-frame guards), so it follows the project's just-in-time
> rule: this index fixes the decomposition, the cross-slice interface registry, the
> global constraints, and the mandatory pre-implementation empirical de-risking;
> each sub-slice plan (2D-1 … 2D-4) is written in full with superpowers:writing-plans
> immediately before it executes, and executed with superpowers:subagent-driven-development.
> Load `/reatom` and `/errore` before touching code (CLAUDE.md mandate).

**Goal:** Build `src/host/supervisor/` — the Kernel-side **standalone**
`HostSupervisor` that owns the design-host child process end to end (spawn →
framed stdio → handshake → mount → live frames → graceful/forced stop → reap),
plus the capacity-one latest-wins frame broker, a `PreviewSession`-shaped typed
handle, one-shot `smoke`/`export` sessions, bounded queues/backpressure, timeouts,
and the per-`(pageSlug, sourceHash)` restart budget + circuit breaker — per
`docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` §3, §4, §8,
§9, §10, §12, §13.

**Architecture:** `host/supervisor/` is the fourth submodule of the `host/`
adapter and the mirror image of 2C: 2C is the code **inside** the child; 2D is the
code that **spawns and drives** it from the parent. It consumes 2A's codecs
(`encodeClientHello`, `decodeHostHello`, `encode/decodeControlEnvelope`,
`decodeFrameEnvelope`, `PROTOCOL_HARD_LIMITS`, `validatePublicLimits`), 2A's
`ProtocolError`, and `infrastructure/framing` (`FrameDecoder`, `WireFrame`, the
limit constants). Every impure boundary — `Bun.spawn`, the byte streams, the
monotonic clock, and UUID/nonce minting — is **injected**, so the whole supervisor
is testable against a scripted in-memory fake host with a fake clock, no real
subprocess. The supervisor actor is a single serialized state machine (§10): all
resize/input/source-change/crash notifications funnel through it so two children are
never live for one session.

**Not in 2D (deferred, documented — do NOT half-build):** the Kernel itself
(Command/Result/Event DTOs, capability publication, wiring the broker onto the
Kernel event channel — phase 6). 2D builds the supervisor as a **standalone** owner
and exposes the typed `HostSession`/`PreviewSession` handles; phase 6 injects it.
Geometry queries (`query-hit`/`query-rect`/`query-describe`/`query-layout`) and the
bulk `capture`/`layout` reply are deferred with 2C (they need new 2A frame/bulk
schemas the child does not speak yet); `FrameToken`/`GeometryToken` minting and
resolution ride with them. Input forwarding, `set-tweak`, `set-theme`/
`set-capabilities`, and `navigation`/`runtime-warning`/`done` handling are deferred
(the 2C child does not emit or accept them). The 2C `export` one-shot emits the
non-conformant preview-shaped `frame` stand-in; the conformant correlated `capture`
reply is a **2D-4 follow-up gated on the new bulk schema** and is NOT built until
that schema lands — until then 2D-4's `export` session is the same one-shot-lifetime
stand-in, and the export supervisor must NOT route its frame to any preview stream.

**Tech Stack:** TypeScript 7.0.2, Bun ≥1.3.14 (`Bun.spawn`, `Bun.nanoseconds`,
`Bun.randomUUIDv7`, `crypto.getRandomValues`), `errore` 0.14.1, `bun:test`. No new
runtime dependencies. `@opentui/*` and `react` are **not** imported by the
supervisor — it never renders; it only moves bytes and manages a process.

## Global constraints (inherited by every 2D-N sub-plan)

Every sub-plan repeats the roadmap's **Global constraints**
(`2026-07-17-termcraft-mvp-roadmap.md`) and the phase-2 index's constraints
(`2026-07-17-mvp-phase-2-host.md`) by reference; its tasks must obey them.
2D-critical items, repeated because they bite:

- **errore mandatory:** namespace import; errors as values (`Error | T`); reuse 2A's
  `ProtocolError` (stable `code`) for every protocol-layer failure and add
  supervisor-domain tagged errors (`SupervisorError` family) for lifecycle/queue/
  timeout failures; one-line `instanceof Error` early returns; flat control flow;
  never silently swallow. **`errore.try` / `.catch()` only at real boundaries**
  (`Bun.spawn`, stream reads/writes, the codecs already return values).
  **CARRIED TRAP (2C review):** `errore.try` RE-THROWS a caught value that is not
  `instanceof Error`; **Bun build/transpile errors are non-Error, and a `Bun.spawn`
  failure or a stream error may be non-Error too** — probe each boundary (de-risking
  D1) and, where the throw is non-Error, use a raw `try/catch` inside an IIFE that
  maps ANY throw to a typed error value. Do not assume `errore.try` catches it.
- **Reatom v1001:** the supervisor session state machine is a candidate for named
  Reatom atoms/actions **only if** 2D chooses to expose lifecycle as observable atoms;
  the spec's §10 machine is "a serialized state machine owned by the supervisor," and
  the roadmap's hardening rule is explicit: **critical process/transaction/timer
  lifetimes are owned by the supervisor, NOT by `withConnectHook`.** So timers
  (heartbeat watchdog, request timeouts, backoff), the child process handle, and the
  frame iterator are owned by supervisor code with explicit teardown on every exit
  path — never a connect hook. If any atom is introduced, name it (RTM-S05) and keep
  its lifetime supervisor-owned. Prefer plain closures for the driver (consistent with
  the 2C child, which the full Reatom audit confirmed is correctly non-Reatom).
- **Framing reuse:** the supervisor writes **already-framed** bytes from the 2A
  encoders (`encodeClientHello`/`encodeControlEnvelope` return the 8-byte header +
  payload) straight to child stdin; it reads child stdout through **one**
  `infrastructure/framing.FrameDecoder` per incarnation, yielding
  `WireFrame{messageClass: "control" | "data", payload}`, then decodes control
  payloads with `decodeHostHello`/`decodeControlEnvelope` and data payloads with
  `decodeFrameEnvelope`. Fragmentation is normal (Spike E). Do not reinvent framing.
- **Identity is supervisor-minted, never child-supplied (§3.1):** the supervisor
  generates `sessionId` (UUIDv7, stable across restart) and a fresh `nonce`
  (128 random bits, 32 lowercase hex) per incarnation; it computes `sourceHash`
  before spawn; it does **not** accept a caller-provided `sessionId`/`nonce`. Every
  decoded inbound envelope must match the current incarnation's `sessionId` **and**
  `nonce` — a mismatch is fatal for that child (§10.1). The frame broker re-checks
  session, nonce, sourceHash, and monotonic `frameSeq` before every replace.
- **No resync (§5):** a decode/identity/sequence failure terminates the incarnation;
  the parser never scans for a new prefix. Terminate → reap → (restart within budget
  OR open circuit per §10 classification).
- **All durations monotonic (§9):** inject `now(): number` (monotonic ms). Every
  timeout uses it: spawn→hello 3s, mount→ready 10s, ordinary/query request 2s,
  one-shot capture 10s, heartbeat emit 1s / no-heartbeat 5s, shutdown→ack 1s,
  forced-termination→reap 1s. Three request timeouts in 10s ⇒ unresponsive ⇒ restart.
- **Bounded everything (§8/§13):** ordered outbound control queue 256 + 1 reserved
  shutdown slot (reject a new non-coalescible command with `HOST_BACKPRESSURED`);
  outstanding request table 64 (`TOO_MANY_REQUESTS`); inbound control mailbox 256 + 1
  reserved terminal slot (`CONTROL_BACKPRESSURE` ⇒ kill); frame broker 1 (atomic
  replace, `framesCoalesced++`); captured stderr tail 65,536 B (drop oldest, count
  discarded); malformed stdout excerpt 8,192 B; ≤10 host processes globally, export
  pool ≤8, Kernel-owned start queue 64 else `HOST_CAPACITY`. Flood limits: >1,000
  frame envelopes or 128 MiB frame payload / rolling second ⇒ `PROTOCOL_FLOOD`;
  >1 MiB stderr / rolling second ⇒ `STDERR_FLOOD`.
- **Restart budget + circuit breaker (§10):** key `(pageSlug, sourceHash)`, budget
  shared by preview + historical for that source and visible to all callers. Initial
  spawn = attempt 1; ≤3 automatic restarts in a rolling 60s (4 failed incarnations
  total); deterministic base-2 backoff 250/500/1000 ms, each beginning only after the
  failed child is fully reaped. Crash/broken-pipe/heartbeat-timeout/repeated-request-
  timeout/transient-spawn consume the budget. Framing/schema/identity/negotiation/
  kit-API/source-hash/flood failures are deterministic/hostile ⇒ open the circuit
  **immediately** (skip remaining automatic attempts). 60s continuous `ready` clears
  the non-open failure history for that key. Once open, stays open; a **manual retry**
  clears the key's history once and starts a fresh incarnation with the same
  `sessionId` + a new `nonce`. A source change stops the old session and creates a new
  `sessionId` under the new key (fresh budget); theme/capability/size changes do not
  reset the budget. Exactly one `preview.circuitOpened` on open; no background spawns.
- **Stale incarnations/frames (§10.1):** on restart, close the old incarnation's
  parser and frame publisher **before** publishing the new `nonce`; old-process bytes
  stay bound to the closed decoder. Closing/superseding a `PreviewSession` closes its
  frame iterator.
- **Isolation (§13):** spawn the current binary + an **argument array**, never a
  shell string; child gets only stdin/stdout/stderr pipes, **no** terminal handle;
  env rebuilt from a small allowlist (no inherited API keys/tokens/agent session
  values; explicit locale `C.UTF-8` + timezone `UTC`; `PATH` not required); cwd is a
  fresh scratch dir; the page source + embedded runtime are read-only inputs; project
  root/staging/Git/chats/pins/export dest are **not** host-owned. Workspace-trust is
  checked before any host starts (the trust check is injected — the trust ledger is
  phase 4; 2D takes a `checkTrust()` port and a test double). **Self-spawn path
  (Spike E):** `process.execPath` names the child only inside the compiled binary;
  under `bun run` it is the Bun CLI — so 2D takes the spawn **command** as an injected
  `SpawnCommand` (`{ cmd: string[]; }`); the `execPath`-vs-dev branch is the phase-8
  composition root's job, NOT 2D's.
- **Diagnostics (§13):** the supervisor emits a bounded, structured diagnostic
  candidate (mode, page slug, source-hash prefix, kit API version, session id, nonce
  prefix, lifecycle phase, restart attempt, error code, monotonic timestamp, exit
  code/termination reason, last heartbeat age, last request id, last accepted frame
  seq, queue high-water marks, `framesCoalesced`, late-response count, discarded
  stderr bytes, a bounded redacted message). ANSI/control sequences escaped; absolute
  paths, env values, and source contents omitted. 2D emits these to an injected
  diagnostics **port** (a sink interface); the projections store is phase 4/6.
- **Green gates:** `bun test` + `bun x tsc --noEmit` clean after every task, and
  `bun test` returns to the shell (no hang — every fake/real child and every timer is
  torn down; a real-spawn test must `kill` + await exit in `afterEach`).
- **Language/commits:** English everywhere; frequent commits, one capability each,
  `feat:`/`test:`/`fix:`/`docs:` prefixes, Claude co-author trailer.

## Sub-slices (dependency-ordered)

Each produces working, independently-tested software (`bun test` + tsc green at its
boundary). Written and executed one at a time (JIT).

| Slice | Plan doc (write JIT) | Produces | Depends on | Primary spec |
|---|---|---|---|---|
| 2D-1 | `2026-07-18-mvp-phase-2d1-transport-lifecycle.md` | `supervisor/` core: `SpawnCommand`/env/scratch, framed stdio transport + stderr drain, supervisor-side handshake, mount→ready, graceful/forced stop + reap, the serialized session state machine driving ONE incarnation with the §9 timeouts | 2A, 2C, `infrastructure/framing` | §3.1, §5, §6, §9, §13 |
| 2D-2 | `2026-07-18-mvp-phase-2d2-broker-preview.md` | capacity-1 latest-wins **frame broker** with §10.1 stale guards; the `PreviewSession` facade subset the 2C child supports (`identity` sans nonce, `frames` AsyncIterable, `resize`, `setMode`, `retry`, `close`); request table + 2s query timeout + `SUPERSEDED`; heartbeat 5s watchdog | 2D-1 | §3.2, §7, §8 (broker rows), §9, §10.1 |
| 2D-3 | `2026-07-18-mvp-phase-2d3-restart-backpressure.md` | restart budget + base-2 backoff + circuit breaker per `(pageSlug,sourceHash)`; bounded ordered control queue (256+1) with coalescible-resize handling + `HOST_BACKPRESSURED`/`preview.writable`; inbound mailbox bound; flood detection (`PROTOCOL_FLOOD`/`STDERR_FLOOD`); the `HostSupervisor` object owning multiple sessions + the ≤10 global host limit + `HOST_CAPACITY` start queue | 2D-1, 2D-2 | §8, §10, §12, §13 |
| 2D-4 | `2026-07-18-mvp-phase-2d4-oneshot.md` | one-shot `smoke`/`export` sessions (spawn→mount→one frame→exit; **no** restart; deterministic export env `C.UTF-8`/`UTC`/`t=0`); the export bounded pool (`min(4, max(1, floor(cpu/2)))`, 1–8) + manifest-order assembly scaffolding; documents the correlated-`capture` deferral gate | 2D-1, 2D-3 | §4, §11.3, §11.4, §13 |

2D-2 is the phase-6-facing deliverable (`PreviewSession`). 2D-3 turns a single-shot
supervisor into a crash-loop-safe one. 2D-4 adds the non-restarting one-shot modes.
2D-1 is the foundation all three build on and MUST be de-risked first (below).

## Cross-slice interface registry

Names fixed here; exact signatures pinned in the slice that defines them, consumed
verbatim by later slices. All new public types land in `src/host/types.ts` (host
vocabulary) or `src/host/supervisor/types.ts` (supervisor-internal), per the phase-2
port-placement note — nothing is lifted into a `core/ports/` folder until phase 6.

| Interface | Defined in | Consumed by | Authority |
|---|---|---|---|
| `HostSessionSpec`, `HostSessionIdentity` | 2D-1 `host/types.ts` | all 2D, phase 6 | §3.1 |
| `SpawnCommand`, `SpawnedChild` (injected `Bun.spawn` seam) | 2D-1 `supervisor/types.ts` | all 2D, phase 8 | §13, Spike E |
| `SupervisorError` family (tagged; lifecycle/queue/timeout codes) | 2D-1 `supervisor/model/errors.ts` | all 2D | §12 |
| `HostSession` (typed handle: mode-scoped commands, requests, control events, frames, stop) | 2D-1 `supervisor/types.ts` | 2D-2/3/4, phase 6 | §3.1 |
| session state machine (`created→…→stopped`, `failed→backoff→…`, `→circuit-open`) | 2D-1 `supervisor/model/session.ts` | 2D-3 (restart hooks) | §10 |
| `PreviewFrame` (immutable displayed frame value) | 2D-2 `host/types.ts` | 2D-2, phase 6/7 | §3.2, §5.3 |
| `PreviewSession` (facade subset) | 2D-2 `supervisor/model/preview-session.ts` | phase 6/7 | §3.2 |
| frame broker (capacity-1, stale guards, `frames` iterable) | 2D-2 `supervisor/model/frame-broker.ts` | 2D-3, phase 6 | §8, §10.1 |
| request table (64, 2s, `SUPERSEDED`) | 2D-2 `supervisor/model/request-table.ts` | 2D-3 | §7, §8, §9 |
| restart policy (budget/backoff/circuit per key) | 2D-3 `supervisor/model/restart-policy.ts` | `HostSupervisor` | §10 |
| ordered control queue (256+1, coalescing, backpressure) | 2D-3 `supervisor/model/control-queue.ts` | session, `HostSupervisor` | §8 |
| `HostSupervisor` (creates sessions, global ≤10, one-shot factories) | 2D-3 `supervisor/model/supervisor.ts` | 2D-4, phase 6 | §2, §13 |
| one-shot `smoke`/`export` session APIs | 2D-4 `supervisor/model/one-shot.ts` | phase 3 (gate smoke), phase 6 (export) | §4, §11.3, §11.4 |
| `SmokeRenderer` port impl (gate-facing) | 2D-4 `supervisor/` (shape in `types.ts`) | phase 3 gate | code-structure §5, §11.3 |

## Pre-implementation empirical de-risking (MANDATORY before 2D-1)

2C's experience proved that a detailed plan written ahead of runtime bakes in wrong
assumptions (the `scanImports`-doesn't-throw miss). 2D touches **real OS process
behavior**, so the implementer MUST run these probes FIRST (as throwaway scripts
under `bun` or committed `docs/spikes`-style checks), record the results in the 2D-1
plan's "Empirical notes", and let the findings shape the code — do NOT write 2D-1's
implementation from assumption:

- **D1 — Bun.spawn framed-stdio round-trip on Windows.** Spawn the real 2C
  `runHostStdio` entry (via a tiny wrapper `main`-lite that wires `Bun.stdin`/stdout),
  write a framed `client.hello`, read the framed `host.hello` back through a
  `FrameDecoder`. Confirm: pipes are byte transports (Spike E said yes — reconfirm on
  this tree); a `Bun.spawn` failure (bad cmd) throws — capture whether the throw is
  `instanceof Error` (drives the errore-vs-raw-try/catch choice); `proc.stdin.write`
  backpressure/flush semantics; how EOF/child-exit surfaces on `proc.stdout` and
  `proc.exited`.
- **D2 — kill + reap timing and confirmation.** Measure `proc.kill()` →
  `await proc.exited` latency; whether `proc.exited` resolves with the code on both
  graceful and forced paths; whether a second `kill` after exit is safe. Cross-check
  Spike I's Job-Object read-confirmation for the graceful-cancel case (the crash-path
  confirmation gap stays `unhealthy_unconfirmed_exit`, per the round-2 findings — do
  not try to close it here).
- **D3 — stderr drain + no-terminal-handle.** Confirm `proc.stderr` drains
  independently and a large stderr burst does not block stdout parsing; confirm the
  child sees no TTY (its `setRawMode` shim exists but no real terminal handle is
  passed). Confirm env-allowlist spawn (`env:` option) actually replaces, not merges.
- **D4 — fake-clock timeouts under bun:test.** Decide the injected-clock design: a
  `now()` + a schedulable timer seam so the §9 timeouts (3s/10s/2s/5s/1s) are tested
  deterministically WITHOUT real waits (real waits would make the suite slow and
  flaky). Prove a scripted advance fires a timeout callback exactly once.

Each probe's finding becomes an "Empirical notes for the implementer" bullet in the
relevant 2D-N task, exactly as 2B/2C did.

## Testing strategy (per §14, mapped to slices)

- 2D-1: lifecycle happy path (spawn→negotiate→mount→ready→graceful stop→reap, no
  leaked handles/timers); the 3s/10s/1s deadlines via the fake clock + scripted fake
  host (§14.4); handshake rejection (no-common-version, stricter-child-limits,
  source-hash/kit-API mismatch open the circuit path stub) (§14.1); identity-echo
  verification; forced stop after ack timeout.
- 2D-2: slow-consumer bounded broker (drive frames faster than a blocked consumer;
  assert latest-wins, memory bounded, lifecycle events still flow) (§14.2); stale
  old-nonce frame rejected at the broker after a restart (§14.3); a delayed
  set-mode/ping response completes exactly once; runtime mode atoms/flags change only
  on an accepted matching response (§14.5); heartbeat-timeout kills.
- 2D-3: fill the ordered queue (accepted commands keep order, next discrete command
  gets `HOST_BACKPRESSURED`, `preview.writable` below low-water) (§14.2); crash four
  incarnations for one key ⇒ 250/500/1000 ms backoff + one latched `circuitOpened` +
  no fifth spawn (§14.4); deterministic protocol failure opens the circuit
  immediately; manual retry resets the key once; source change gets a fresh key/
  session id; size/theme changes do neither; `HOST_CAPACITY` past the global limit.
- 2D-4: fresh process per smoke/export miss; smoke failure returns a typed result
  with no restart and no preview frame; export pool sizes 1 and 4 produce identical
  ordering (scaffold; byte-identical output is gated on the real render-cache, phase 4);
  no more than the configured/global host counts alive.

## Self-review checklist (run before writing each 2D-N sub-plan)

- Every §-referenced behavior in the slice's "Primary spec" column maps to a task.
- No placeholder steps; full TDD code per step; exact run commands + expected output.
- Types consumed in a later task match the names/shapes this index fixed.
- Every injected boundary (`SpawnCommand`, `now`, nonce/uuid mint, `checkTrust`,
  diagnostics sink) has a test double; no test spawns a real process except the
  explicitly-marked D1/D2 integration checks (which `kill`+await in `afterEach`).
- Deferrals (geometry/bulk-capture/tokens, input/tweaks/set-theme, Kernel wiring,
  correlated `capture`) are stated in the slice's scope, NOT half-implemented.
- errore: `errore.try` only where the throw is proven `instanceof Error`; a raw
  try/catch IIFE at every boundary proven to throw non-Error (Bun.spawn / streams —
  per D1); `ProtocolError` for wire failures, `SupervisorError` for lifecycle.
- Reatom: timers/process/iterator lifetimes are supervisor-owned with explicit
  teardown, never a connect hook (roadmap hardening rule).

## Out of scope for phase 2D (deferred to their phase)

- The Kernel Command/Result/Event DTOs, capability publication, and wiring the broker
  onto the Kernel event channel (phase 6); `PreviewSession` as typed Kernel-command
  adapters (phase 6 — 2D exposes the standalone handle).
- Geometry queries + bulk `capture`/`layout` schemas + `FrameToken`/`GeometryToken`
  (need new 2A schemas; ride together in a later phase-2/phase-6 follow-up).
- Input forwarding, `set-tweak`, `set-theme`/`set-capabilities`, `navigation`/
  `runtime-warning`/`done` (the 2C child neither accepts nor emits them).
- The trust ledger, `SafeProjectFs`, leases, transactions, the render cache, and the
  projections/diagnostics store (phase 4) — 2D takes injected `checkTrust()` and a
  diagnostics sink port with test doubles.
- The `execPath`-vs-`bun run` spawn-command branch and argv dispatch (phase-8
  composition root) — 2D takes an injected `SpawnCommand`.

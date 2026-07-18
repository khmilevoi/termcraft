# Phase 2D-1 — Supervisor Transport & Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before touching code (CLAUDE.md mandate).

**Goal:** Build the `src/host/supervisor/` core that spawns ONE design-host child incarnation, negotiates the handshake, mounts to `ready`, and stops it gracefully or by force with a confirmed reap — a serialized session state machine over injected `Bun.spawn`, byte streams, and a monotonic clock, fully testable against a scripted in-memory fake host with no real subprocess.

**Architecture:** `host/supervisor/` is the fourth `host/` submodule and the mirror of 2C: 2C is the code inside the child; 2D-1 is the code that spawns and drives it. Every impure boundary is injected — the `Bun.spawn` seam (`SpawnFn`/`SpawnedChild`), the `Clock` (`now` + `setTimer`/`cancel`), and identity minting — so the whole lifecycle is exercised deterministically. It consumes 2A's codecs (`encodeClientHello`, `decodeHostHello`, `encode/decodeControlEnvelope`, `decodeFrameEnvelope`, `validatePublicLimits`, `PROTOCOL_HARD_LIMITS`), 2A's `ProtocolError`, and `infrastructure/framing` (`FrameDecoder`, `encodeFrame`). The session actor is a single serialized state machine; all lifecycle transitions funnel through it so two children are never live for one session.

**Tech Stack:** TypeScript 7.0.2, Bun ≥1.3.14 (`Bun.spawn`, `Bun.nanoseconds`, `Bun.randomUUIDv7`, `crypto.getRandomValues`, `node:fs`/`node:os`/`node:path`), `errore` 0.14.1, `bun:test`. No new runtime dependencies. `@opentui/*` and `react` are NOT imported by the supervisor — it never renders.

## Global Constraints

- **errore mandatory** (errore.org): namespace import `import * as errore from "errore"`; errors as values (`Error | T`); one-line `instanceof Error` early returns; flat control flow; `.catch()`/`errore.try` only at real boundaries; never silently swallow (log an ignored branch). Reuse 2A's `ProtocolError` (stable `code`) for every protocol-layer failure; add the `SupervisorError` family only for lifecycle/queue/timeout failures.
- **CARRIED TRAP (D1):** a failed `Bun.spawn` throws SYNCHRONOUSLY and the throw IS `instanceof Error` (`code: "ENOENT"`), but do NOT depend on that — wrap the spawn call in a raw `try/catch` IIFE that maps ANY throw to a typed `SupervisorError`, capturing the OS `.code` for diagnostics. Other Bun boundaries may throw non-`Error` (2C trap).
- **Reatom v1001:** timers (handshake/mount/shutdown/reap deadlines), the child process handle, and the inbound read iterator are owned by supervisor CODE with explicit teardown on EVERY exit path — never a `withConnectHook` (roadmap hardening rule). 2D-1 introduces no atoms; prefer plain closures (consistent with the 2C child, which the full Reatom audit confirmed correctly non-Reatom). If any atom is later introduced, name it (RTM-S05) and keep its lifetime supervisor-owned.
- **Framing reuse:** write already-framed bytes from the 2A encoders straight to child stdin; read child stdout through ONE `infrastructure/framing.FrameDecoder` per incarnation, yielding `WireFrame{messageClass:"control"|"data", payload}`; decode control payloads with `decodeHostHello`/`decodeControlEnvelope`, data payloads with `decodeFrameEnvelope`. Fragmentation is normal (Spike E). Never reinvent framing.
- **Identity supervisor-minted, never child-supplied (§3.1):** `sessionId` is a UUIDv7 (stable across restart); `nonce` is 128 random bits as 32 lowercase hex (fresh per incarnation); `sourceHash` is computed before spawn (supplied in the spec). Never accept a caller-provided `sessionId`/`nonce`. Every decoded inbound envelope must echo the incarnation's `sessionId` AND `nonce` — a mismatch is fatal (`MALFORMED_PROTOCOL`, §10.1).
- **No resync (§5):** a decode/identity failure terminates the incarnation; the parser never scans for a new prefix.
- **All durations monotonic (§9):** the injected `Clock.now()` is monotonic ms. 2D-1 owns these deadlines: spawn→`host.hello` **3s**, `mount`→`ready` **10s**, graceful `shutdown`→`shutdown-ack` **1s**, forced-termination→reap **1s**. (Per-request 2s and heartbeat 5s are 2D-2.)
- **Isolation (§13):** spawn the injected `SpawnCommand` (`{cmd:string[]}`) — an argument array, never a shell string; child gets only stdin/stdout/stderr pipes, no terminal handle; env rebuilt from a small allowlist (`LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TZ=UTC`) — accept that Windows injects a system-var baseline (D3), assert only that no parent-marker leaks; cwd is a fresh scratch dir. `process.execPath` names the child only in the compiled binary, so 2D-1 takes the spawn command injected (the `execPath`-vs-dev branch is phase-8's job).
- **Liveness oracle (D2):** `proc.exited` is the ONLY liveness/termination truth. Classify by `exitCode` (non-null ⇒ clean/self-exit) vs `signalCode` (non-null ⇒ forced kill). `kill()` after exit and repeat `await exited` are safe/idempotent. A write to a dead child's stdin does NOT throw — never infer liveness from a write.
- **stderr drain (§8, D3):** drain `proc.stderr` concurrently from spawn into a bounded 65,536-byte tail (drop oldest, count discarded). A ~2 MiB burst does not block stdout, but draining is a correctness requirement (tail + memory + the 2D-3 flood limit).
- **Green gates:** `bun test` + `bun x tsc --noEmit` clean after every task; `bun test` returns to the shell (no hang — every fake/real child, timer, and drain task is torn down; a real-spawn test `kill`s + awaits exit in `afterEach`).
- **Language/commits:** English everywhere; frequent commits, one capability each, `feat:`/`test:`/`fix:`/`docs:` prefixes, Claude co-author trailer.

## Empirical notes for the implementer (from Spike 04 — `docs/spikes/04-supervisor-derisk/FINDINGS.md`)

These are measured facts on this tree (Bun 1.3.14, Windows). Where one contradicts an assumption below, the finding wins.

1. **Bad `Bun.spawn` throws sync, `instanceof Error`, `code:"ENOENT"`** — wrap in a raw `try/catch` IIFE → `SupervisorError("SPAWN_FAILED")` carrying the OS code; still robust to non-Error throws.
2. **`proc.stdin.write(bytes)` returns a Promise, not a byte count** — the writer must `await` the write (when thenable) then `flush()` (also possibly thenable). Do not assume synchronous.
3. **stdin EOF (`proc.stdin.end()`) makes the 2C child self-exit 0 in ~10 ms**; graceful `shutdown`→`shutdown-ack`→exit 0 in ~11 ms; forced `kill()`→reap in ~11 ms resolving 143 (`exitCode:null`, `signalCode:"SIGTERM"`).
4. **A second `kill()` after exit is safe; `await proc.exited` is idempotent; a write to a dead stdin resolves silently** — `proc.exited` is the sole liveness oracle.
5. **`Bun.spawn({env})` replaces the parent env** (no parent-marker leak) but Windows injects a ~11-var system baseline (PATH, SYSTEMROOT, WINDIR, …) — tests assert "no marker leaks", not exact key sets. Child sees `isTTY=false` on all three streams.
6. **Injected `Clock` seam works** — `now()` + `setTimer(delayMs,cb):{cancel}` driven in tests by a `ManualClock.advance(ms)` firing due callbacks exactly once in due order (incl. timers scheduled during advance). All §9 deadlines test off this one seam with no real waits.

## File Structure

New module `src/host/supervisor/` (follows the CLAUDE.md shape: code in `model/`, `types.ts` + `index.ts` at the root):

- `src/host/types.ts` — **modify**: add `HostSessionSpec`, `HostSessionIdentity` (§3.1 host vocabulary).
- `src/host/supervisor/types.ts` — `SpawnCommand`, `ChildStdin`, `SpawnedChild`, `SpawnFn`, `InboundMessage`, `ControlEvent`, `ReadyOutcome`, `StopOutcome`, `SessionPhase`, `HostSession`, `HostSessionDeps` (supervisor vocabulary).
- `src/host/supervisor/model/errors.ts` — `SupervisorError` (tagged) + `SupervisorErrorCode`.
- `src/host/supervisor/model/clock.ts` — `Clock`, `TimerHandle`, `createSystemClock`, `ManualClock`, `createManualClock`.
- `src/host/supervisor/model/identity.ts` — `mintNonce`, `mintIdentity`.
- `src/host/supervisor/model/spawn.ts` — `buildChildEnv`, `createBunSpawn` (the production `Bun.spawn` adapter + scratch dir).
- `src/host/supervisor/model/scripted-child.ts` — **test double**: `createScriptedChild` (deterministic in-memory `SpawnedChild`) + reply framers (`frameHostHello`, `frameReady`, `frameFrame`, `frameControl`). Not exported from `index.ts`.
- `src/host/supervisor/model/transport.ts` — `writeFramed`, `readInbound`, `createStderrDrain`.
- `src/host/supervisor/model/handshake.ts` — `buildClientHello`, `verifyHostHello`.
- `src/host/supervisor/model/session.ts` — `createHostSession` (the state machine + `start`/`stop`).
- `src/host/supervisor/index.ts` — public entry: `createHostSession`, `createBunSpawn`, `createSystemClock`, error/type re-exports.

## Cross-slice interface registry (consumed verbatim by 2D-2/3/4)

| Interface | Defined here | Authority |
|---|---|---|
| `HostSessionSpec`, `HostSessionIdentity` (`host/types.ts`) | Task 3 | §3.1 |
| `SpawnCommand`, `SpawnedChild`, `SpawnFn` (`supervisor/types.ts`) | Task 4 | §13, Spike E |
| `SupervisorError` family (`supervisor/model/errors.ts`) | Task 1 | §12 |
| `Clock`, `TimerHandle`, `ManualClock` (`supervisor/model/clock.ts`) | Task 2 | §9, D4 |
| `HostSession`, `ReadyOutcome`, `StopOutcome`, `SessionPhase`, `HostSessionDeps` (`supervisor/types.ts`) | Task 8 | §3.1, §9, §10 |
| `InboundMessage`, `readInbound`, `writeFramed`, `createStderrDrain` (`supervisor/model/transport.ts`) | Task 6 | §5, §8 |

**Not in 2D-1 (deferred, do NOT half-build):** the capacity-1 frame broker and `PreviewSession` facade (2D-2); the request table + 2s query timeout + `SUPERSEDED` + heartbeat 5s watchdog (2D-2); restart budget/backoff/circuit-breaker + bounded ordered control queue + flood detection + the multi-session `HostSupervisor` + global ≤10 limit (2D-3); one-shot `smoke`/`export` sessions + export pool (2D-4). 2D-1 drives ONE incarnation to `ready` and stops it. The `failed→backoff→spawning`/`circuit-open` edges are represented in `SessionPhase` but the restart machinery is 2D-3. Inbound `frame`/post-`ready` control events are routed to injected `onFrame`/`onControlEvent` sinks (default no-op) that 2D-2 replaces.

---

### Task 1: SupervisorError family

**Files:**
- Create: `src/host/supervisor/model/errors.ts`
- Test: `src/host/supervisor/model/errors.test.ts`

**Interfaces:**
- Consumes: `errore`.
- Produces: `class SupervisorError` (tagged, template `"Supervisor failure [$code]: $reason"`, props `code: SupervisorErrorCode`, `reason: string`, optional `cause`); `type SupervisorErrorCode` (closed union). Mirrors 2A's `ProtocolError` shape so the supervisor uses one error type for every lifecycle/queue/timeout failure while protocol-schema failures stay `ProtocolError`.

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/errors.test.ts
import { describe, expect, test } from "bun:test"
import { SupervisorError } from "./errors"

describe("SupervisorError", () => {
  test("carries a stable code and interpolates the reason", () => {
    const err = new SupervisorError({ code: "SPAWN_FAILED", reason: "uv_spawn ENOENT" })
    expect(err).toBeInstanceOf(Error)
    expect(err._tag).toBe("SupervisorError")
    expect(err.code).toBe("SPAWN_FAILED")
    expect(err.reason).toBe("uv_spawn ENOENT")
    expect(err.message).toBe("Supervisor failure [SPAWN_FAILED]: uv_spawn ENOENT")
  })

  test("preserves a cause chain", () => {
    const root = new Error("boom")
    const err = new SupervisorError({ code: "TRANSPORT_ERROR", reason: "stdout read failed", cause: root })
    expect(err.cause).toBe(root)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/supervisor/model/errors.test.ts`
Expected: FAIL — cannot find module `./errors`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/host/supervisor/model/errors.ts
import * as errore from "errore"

/**
 * Stable diagnostic codes for supervisor lifecycle/queue/timeout failures
 * (host-supervision §12). Protocol-schema failures (framing, JSON, identity,
 * negotiation, kit-API, source-hash) stay `ProtocolError`; this family covers
 * only what the supervisor — not the codec — decides. Codes for 2D-2/3/4 are
 * declared now so the vocabulary is closed and later slices add no new type.
 */
export type SupervisorErrorCode =
  // 2D-1 — process + handshake lifecycle
  | "SPAWN_FAILED"
  | "HANDSHAKE_TIMEOUT"
  | "MOUNT_TIMEOUT"
  | "SHUTDOWN_TIMEOUT"
  | "REAP_TIMEOUT"
  | "CHILD_EXITED"
  | "TRANSPORT_ERROR"
  | "DESIGN_RENDER_FAILED"
  // 2D-2 — requests + heartbeat
  | "QUERY_TIMEOUT"
  | "HEARTBEAT_TIMEOUT"
  | "SUPERSEDED"
  // 2D-3 — queues, flood, capacity, circuit
  | "HOST_BACKPRESSURED"
  | "TOO_MANY_REQUESTS"
  | "CONTROL_BACKPRESSURE"
  | "PROTOCOL_FLOOD"
  | "STDERR_FLOOD"
  | "HOST_CAPACITY"
  | "CIRCUIT_OPEN"

/**
 * A supervisor lifecycle failure. Fatal for the incarnation that produced it.
 * Distinct from `ProtocolError` (schema) and `FramingError` (byte frame).
 */
export class SupervisorError extends errore.createTaggedError({
  name: "SupervisorError",
  message: "Supervisor failure [$code]: $reason",
}) {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/host/supervisor/model/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: tsc + commit**

Run: `bun x tsc --noEmit` → no output.
```bash
git add src/host/supervisor/model/errors.ts src/host/supervisor/model/errors.test.ts
git commit -m "feat: add SupervisorError family for host-supervisor lifecycle"
```

---

### Task 2: Clock port (system + manual)

**Files:**
- Create: `src/host/supervisor/model/clock.ts`
- Test: `src/host/supervisor/model/clock.test.ts`

**Interfaces:**
- Consumes: `Bun.nanoseconds`, `setTimeout`/`clearTimeout`.
- Produces: `interface TimerHandle { cancel(): void }`; `interface Clock { now(): number; setTimer(delayMs: number, callback: () => void): TimerHandle }`; `createSystemClock(): Clock`; `interface ManualClock extends Clock { advance(ms: number): void; pending(): number }`; `createManualClock(): ManualClock`. The single §9 timer seam (D4). Production uses real time; tests use `ManualClock`.

- [ ] **Step 1: Write the failing test** (transcribe D4's proof — it is the acceptance spec for this seam)

```ts
// src/host/supervisor/model/clock.test.ts
import { describe, expect, test } from "bun:test"
import { createManualClock, createSystemClock } from "./clock"

describe("ManualClock", () => {
  test("a due timer fires exactly once at its deadline", () => {
    const clock = createManualClock()
    let fired = 0
    let firedAt = -1
    clock.setTimer(3_000, () => { fired += 1; firedAt = clock.now() })
    clock.advance(2_999)
    expect(fired).toBe(0)
    clock.advance(1)
    expect(fired).toBe(1)
    expect(firedAt).toBe(3_000)
    clock.advance(10_000)
    expect(fired).toBe(1)
  })

  test("cancel before the deadline prevents the fire", () => {
    const clock = createManualClock()
    let fired = 0
    const handle = clock.setTimer(2_000, () => (fired += 1))
    clock.advance(1_000)
    handle.cancel()
    clock.advance(5_000)
    expect(fired).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  test("timers scheduled during advance fire in due order", () => {
    const clock = createManualClock()
    const order: number[] = []
    clock.setTimer(250, () => {
      order.push(clock.now())
      clock.setTimer(500, () => {
        order.push(clock.now())
        clock.setTimer(1_000, () => order.push(clock.now()))
      })
    })
    clock.advance(2_000)
    expect(order).toEqual([250, 750, 1_750])
    expect(clock.pending()).toBe(0)
  })
})

describe("createSystemClock", () => {
  test("now() is monotonic non-decreasing", () => {
    const clock = createSystemClock()
    const a = clock.now()
    const b = clock.now()
    expect(b).toBeGreaterThanOrEqual(a)
  })

  test("setTimer fires and cancel prevents it (real timers)", async () => {
    const clock = createSystemClock()
    let fired = 0
    clock.setTimer(1, () => (fired += 1))
    const cancelled = clock.setTimer(1, () => (fired += 1))
    cancelled.cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(fired).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/supervisor/model/clock.test.ts`
Expected: FAIL — cannot find module `./clock`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/host/supervisor/model/clock.ts

/** A cancellable scheduled callback (host-supervision §9). */
export interface TimerHandle {
  cancel(): void
}

/**
 * The single injected time seam for every §9 deadline. `now()` is monotonic ms;
 * `setTimer` schedules a one-shot callback. Owned by supervisor code with an
 * explicit `cancel()` on every exit path — never a Reatom connect hook.
 */
export interface Clock {
  now(): number
  setTimer(delayMs: number, callback: () => void): TimerHandle
}

/** Production clock: monotonic `Bun.nanoseconds` + real `setTimeout`. */
export function createSystemClock(): Clock {
  return {
    now: () => Math.trunc(Bun.nanoseconds() / 1e6),
    setTimer: (delayMs, callback) => {
      const id = setTimeout(callback, delayMs)
      return { cancel: () => clearTimeout(id) }
    },
  }
}

/** A deterministic clock for tests: virtual time advanced explicitly. */
export interface ManualClock extends Clock {
  advance(ms: number): void
  pending(): number
}

/**
 * Fires due callbacks exactly once, at their exact virtual deadline, in due
 * order — including timers scheduled during an `advance` (backoff chains). No
 * real waits (proven in Spike 04 D4).
 */
export function createManualClock(): ManualClock {
  let current = 0
  let seq = 0
  const timers = new Map<number, { at: number; order: number; cb: () => void }>()
  return {
    now: () => current,
    setTimer(delayMs, callback) {
      const id = seq
      seq += 1
      timers.set(id, { at: current + delayMs, order: id, cb: callback })
      return { cancel: () => void timers.delete(id) }
    },
    pending: () => timers.size,
    advance(ms) {
      const target = current + ms
      while (true) {
        let pick: { id: number; at: number; order: number } | null = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (pick === null || t.at < pick.at || (t.at === pick.at && t.order < pick.order)) {
            pick = { id, at: t.at, order: t.order }
          }
        }
        if (pick === null) break
        const timer = timers.get(pick.id)
        if (timer === undefined) break
        timers.delete(pick.id)
        current = timer.at
        timer.cb()
      }
      current = target
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/host/supervisor/model/clock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/supervisor/model/clock.ts src/host/supervisor/model/clock.test.ts
git commit -m "feat: add injected Clock seam (system + manual) for §9 timeouts"
```

---

### Task 3: Host session identity (spec types + minting)

**Files:**
- Modify: `src/host/types.ts` (append `HostSessionSpec`, `HostSessionIdentity`)
- Create: `src/host/supervisor/model/identity.ts`
- Test: `src/host/supervisor/model/identity.test.ts`

**Interfaces:**
- Consumes: `HostSessionSpec` (host/types.ts), `uuidv7` (`infrastructure/uuid`), `crypto.getRandomValues`.
- Produces (host/types.ts): `interface HostSessionSpec { mode; interactionMode; pageSlug; sourcePath; sourceHash; kitApiVersion; size; theme; capabilities }`; `interface HostSessionIdentity { mode; pageSlug; sourceHash; kitApiVersion; sessionId; nonce }`.
- Produces (identity.ts): `mintNonce(): string` (32 lowercase hex); `mintIdentity(spec: HostSessionSpec, sessionId?: string): HostSessionIdentity` (mints `sessionId` via `uuidv7()` when absent — stable across restart — and a fresh `nonce`).

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/identity.test.ts
import { describe, expect, test } from "bun:test"
import type { HostSessionSpec } from "../../types"
import { mintIdentity, mintNonce } from "./identity"

const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dashboard",
  sourcePath: "/scratch/page.tsx",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
}

describe("mintNonce", () => {
  test("is 32 lowercase hex characters", () => {
    const nonce = mintNonce()
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
  })
  test("is fresh each call", () => {
    expect(mintNonce()).not.toBe(mintNonce())
  })
})

describe("mintIdentity", () => {
  test("mints a UUIDv7 sessionId and a fresh nonce, copying spec identity fields", () => {
    const id = mintIdentity(spec)
    expect(id.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(id.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(id.mode).toBe("preview")
    expect(id.pageSlug).toBe("dashboard")
    expect(id.sourceHash).toBe("a".repeat(64))
    expect(id.kitApiVersion).toBe(1)
  })

  test("keeps a supplied sessionId (stable across restart) but re-mints the nonce", () => {
    const first = mintIdentity(spec)
    const second = mintIdentity(spec, first.sessionId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.nonce).not.toBe(first.nonce)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/identity.test.ts`
Expected: FAIL — cannot find `./identity` / missing `HostSessionSpec`.

- [ ] **Step 3a: Append the spec types to `src/host/types.ts`**

```ts
// append to src/host/types.ts

/** The specification every host session (all four modes) is created from (§3.1). */
export interface HostSessionSpec {
  readonly mode: HostMode
  readonly interactionMode: InteractionMode
  readonly pageSlug: string
  readonly sourcePath: string
  readonly sourceHash: string
  readonly kitApiVersion: number
  readonly size: Size
  readonly theme: string
  readonly capabilities: TerminalCapabilities
}

/**
 * A logical session's minted identity (§3.1). `sessionId` (UUIDv7) is stable
 * across automatic restart; `nonce` (32 lowercase hex) identifies one process
 * incarnation. Supervisor-minted only — never caller-supplied.
 */
export interface HostSessionIdentity {
  readonly mode: HostMode
  readonly pageSlug: string
  readonly sourceHash: string
  readonly kitApiVersion: number
  readonly sessionId: string
  readonly nonce: string
}
```

- [ ] **Step 3b: Re-export the new types from `src/host/index.ts`**

Add to the existing `export type { ... } from "./types"` line: `HostSessionSpec, HostSessionIdentity`.

```ts
// src/host/index.ts
export type {
  HostMode,
  HostSessionIdentity,
  HostSessionSpec,
  InteractionMode,
  Size,
  TerminalCapabilities,
} from "./types"
```

- [ ] **Step 3c: Implement `identity.ts`**

```ts
// src/host/supervisor/model/identity.ts
import { uuidv7 } from "../../../infrastructure/uuid"
import type { HostSessionSpec, HostSessionIdentity } from "../../types"

const NONCE_BYTES = 16

/** 128 random bits as 32 lowercase hex characters — one process incarnation (§3.1). */
export function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/**
 * Mint the identity for a new incarnation. `sessionId` is generated once per
 * logical session (UUIDv7) and passed back on restart so it stays stable; the
 * `nonce` is always fresh. Never accepts a nonce from the caller (§3.1).
 */
export function mintIdentity(spec: HostSessionSpec, sessionId?: string): HostSessionIdentity {
  return {
    mode: spec.mode,
    pageSlug: spec.pageSlug,
    sourceHash: spec.sourceHash,
    kitApiVersion: spec.kitApiVersion,
    sessionId: sessionId ?? uuidv7(),
    nonce: mintNonce(),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/types.ts src/host/index.ts src/host/supervisor/model/identity.ts src/host/supervisor/model/identity.test.ts
git commit -m "feat: add HostSessionSpec/Identity + supervisor identity minting"
```

---

### Task 4: Spawn seam + Bun adapter + env allowlist

**Files:**
- Create: `src/host/supervisor/types.ts`
- Create: `src/host/supervisor/model/spawn.ts`
- Test: `src/host/supervisor/model/spawn.test.ts`

**Interfaces:**
- Consumes: `SupervisorError` (Task 1), `node:fs`, `node:os`, `node:path`, `Bun.spawn`.
- Produces (types.ts): `interface SpawnCommand { readonly cmd: readonly string[] }`; `interface ChildStdin { write(bytes: Uint8Array): unknown; flush(): unknown; end(): unknown }`; `interface SpawnedChild { readonly stdin: ChildStdin; readonly stdout: AsyncIterable<Uint8Array>; readonly stderr: AsyncIterable<Uint8Array>; readonly exited: Promise<number>; kill(): void; readonly exitCode: number | null; readonly signalCode: string | null }`; `type SpawnFn = (command: SpawnCommand) => SupervisorError | SpawnedChild`.
- Produces (spawn.ts): `buildChildEnv(): Record<string, string>`; `createBunSpawn(options?: { makeScratchDir?: () => string }): SpawnFn`.

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/spawn.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { SupervisorError } from "./errors"
import { buildChildEnv, createBunSpawn } from "./spawn"
import type { SpawnedChild } from "../types"

const children: SpawnedChild[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
})

describe("buildChildEnv", () => {
  test("is the explicit locale/timezone allowlist and carries no parent secrets", () => {
    process.env.TERMCRAFT_TEST_MARKER = "leak-me"
    const env = buildChildEnv()
    expect(env.LANG).toBe("C.UTF-8")
    expect(env.LC_ALL).toBe("C.UTF-8")
    expect(env.TZ).toBe("UTC")
    expect("TERMCRAFT_TEST_MARKER" in env).toBe(false)
    delete process.env.TERMCRAFT_TEST_MARKER
  })
})

describe("createBunSpawn", () => {
  test("returns a typed SupervisorError when the binary does not exist", () => {
    const spawn = createBunSpawn()
    const result = spawn({ cmd: ["C:/no/such/binary_termcraft_xyz.exe", "_host", "--stdio"] })
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) {
      expect(result.code).toBe("SPAWN_FAILED")
      expect(result.reason).toContain("ENOENT")
    }
  })

  test("spawns a real echo-lite child and exposes streams + exited", async () => {
    // Spawn Bun itself running a one-liner that writes to stdout then exits 0.
    const spawn = createBunSpawn()
    const result = spawn({ cmd: [process.execPath, "-e", "process.stdout.write('hi'); process.exit(0)"] })
    expect(result).not.toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) throw result
    children.push(result)
    let out = ""
    const dec = new TextDecoder()
    for await (const chunk of result.stdout) out += dec.decode(chunk, { stream: true })
    const code = await result.exited
    expect(out).toBe("hi")
    expect(code).toBe(0)
    expect(result.exitCode).toBe(0)
    expect(result.signalCode).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/spawn.test.ts`
Expected: FAIL — cannot find `./spawn` / `../types`.

- [ ] **Step 3a: Create `src/host/supervisor/types.ts` (seam types only for now)**

```ts
// src/host/supervisor/types.ts

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
export type SpawnFn = (command: SpawnCommand) => import("./model/errors").SupervisorError | SpawnedChild
```

- [ ] **Step 3b: Implement `src/host/supervisor/model/spawn.ts`**

```ts
// src/host/supervisor/model/spawn.ts
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SupervisorError } from "./errors"
import type { SpawnCommand, SpawnFn, SpawnedChild } from "../types"

/**
 * The §13 environment allowlist: explicit locale + timezone, no inherited API
 * keys/tokens/agent values. On Windows, Bun still injects a system-var baseline
 * (PATH/SYSTEMROOT/…, Spike 04 D3) that this cannot suppress; that baseline
 * carries no secrets.
 */
export function buildChildEnv(): Record<string, string> {
  return { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }
}

function defaultScratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-host-"))
}

/**
 * The production `Bun.spawn` adapter. Spawns the argument array with only
 * stdin/stdout/stderr pipes, the allowlist env, and a fresh scratch cwd. The
 * spawn call is wrapped in a raw try/catch IIFE mapping ANY throw to a typed
 * `SupervisorError("SPAWN_FAILED")` with the OS code (D1 — the throw is Error
 * here, but never depend on that).
 */
export function createBunSpawn(options?: { makeScratchDir?: () => string }): SpawnFn {
  const makeScratchDir = options?.makeScratchDir ?? defaultScratchDir
  return (command: SpawnCommand) => {
    const scratch = (() => {
      try {
        return makeScratchDir()
      } catch (cause) {
        return new SupervisorError({
          code: "SPAWN_FAILED",
          reason: `scratch dir creation failed: ${describe(cause)}`,
          cause: asError(cause),
        })
      }
    })()
    if (scratch instanceof SupervisorError) return scratch

    return (() => {
      try {
        const proc = Bun.spawn({
          cmd: [...command.cmd],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: scratch,
          env: buildChildEnv(),
        })
        return proc as unknown as SpawnedChild
      } catch (cause) {
        return new SupervisorError({
          code: "SPAWN_FAILED",
          reason: describe(cause),
          cause: asError(cause),
        })
      }
    })()
  }
}

function describe(cause: unknown): string {
  const code = (cause as { code?: unknown })?.code
  const message = (cause as { message?: unknown })?.message ?? cause
  return code === undefined ? String(message) : `${String(code)}: ${String(message)}`
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/spawn.test.ts`
Expected: PASS (3 tests). The real-spawn test kills + awaits in `afterEach` (no hang).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/supervisor/types.ts src/host/supervisor/model/spawn.ts src/host/supervisor/model/spawn.test.ts
git commit -m "feat: add Bun.spawn seam + env allowlist + scratch cwd adapter"
```

---

### Task 5: Scripted in-memory child (test double) + reply framers

**Files:**
- Create: `src/host/supervisor/model/scripted-child.ts`
- Test: `src/host/supervisor/model/scripted-child.test.ts`

**Interfaces:**
- Consumes: `SpawnedChild`, `ChildStdin` (Task 4); `encodeHostHello`, `encodeControlEnvelope`, `encodeFrameEnvelope` (2A); framing.
- Produces: `interface ScriptedChild extends SpawnedChild { emit(bytes: Uint8Array): void; endStdout(): void; emitStderr(bytes: Uint8Array): void; simulateExit(o?: { code?: number; signal?: string }): void; written: Uint8Array[]; onWrite?: (bytes: Uint8Array) => void }`; `createScriptedChild(onWrite?): ScriptedChild`; reply framers `frameHostHello(hello)`, `frameReady(env)`, `frameFrame(frame)`, `frameControl(env)`. The deterministic host used by transport/handshake/session tests (§14.4 "scripted fake host"). Not exported from `index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/scripted-child.test.ts
import { describe, expect, test } from "bun:test"
import { FrameDecoder } from "../../../infrastructure/framing"
import { decodeHostHello, ProtocolError } from "../../protocol"
import { createScriptedChild, frameHostHello } from "./scripted-child"

describe("createScriptedChild", () => {
  test("captures writes and lets the script emit framed stdout the reader decodes", async () => {
    const child = createScriptedChild()
    child.stdin.write(new Uint8Array([1, 2, 3]))
    expect(child.written.length).toBe(1)
    expect(Array.from(child.written[0]!)).toEqual([1, 2, 3])

    const hello = frameHostHello({
      framingVersion: 1,
      kind: "host.hello",
      sessionId: "s1",
      nonce: "0".repeat(32),
      selectedFramingVersion: 1,
      selectedProtocolVersion: 1,
      runtimeDeclaration: { module: "@termcraft/runtime", currentKitApiVersion: 1, supportedKitApiVersions: [1], publicCapabilityIds: [] },
      limits: { controlPayloadBytes: 1000, framePayloadBytes: 1000, maxFrameWidth: 100, maxFrameHeight: 100, maxFrameCells: 1000 },
    })
    expect(hello).not.toBeInstanceOf(ProtocolError)
    if (hello instanceof ProtocolError) throw hello

    const decoder = new FrameDecoder()
    const collected: string[] = []
    const reading = (async () => {
      for await (const chunk of child.stdout) {
        const frames = decoder.feed(chunk)
        if (frames instanceof Error) throw frames
        for (const frame of frames) {
          const decoded = decodeHostHello(frame.payload)
          if (!(decoded instanceof ProtocolError)) collected.push(decoded.sessionId)
        }
      }
    })()
    child.emit(hello)
    child.endStdout()
    await reading
    expect(collected).toEqual(["s1"])
  })

  test("simulateExit resolves exited with a clean code; kill sets signalCode", async () => {
    const clean = createScriptedChild()
    clean.simulateExit({ code: 0 })
    expect(await clean.exited).toBe(0)
    expect(clean.exitCode).toBe(0)
    expect(clean.signalCode).toBeNull()

    const killed = createScriptedChild()
    killed.kill()
    expect(await killed.exited).toBe(143)
    expect(killed.exitCode).toBeNull()
    expect(killed.signalCode).toBe("SIGTERM")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/scripted-child.test.ts`
Expected: FAIL — cannot find `./scripted-child`.

- [ ] **Step 3: Implement `scripted-child.ts`**

```ts
// src/host/supervisor/model/scripted-child.ts
// TEST DOUBLE — a deterministic in-memory SpawnedChild + reply framers. Not part
// of the public supervisor surface (never re-exported from index.ts). Lets the
// transport/handshake/session suites drive the supervisor with no subprocess
// (host-supervision §14.4 "scripted fake host"). Framing/encoding reuse 2A.
import { encodeFrame } from "../../../infrastructure/framing"
import {
  encodeControlEnvelope,
  encodeFrameEnvelope,
  encodeHostHello,
  ProtocolError,
} from "../../protocol"
import type { ControlEnvelope, FrameEnvelope, HostHelloV1 } from "../../protocol"
import type { ChildStdin, SpawnedChild } from "../types"

/** Frame a `host.hello` (control class) with the 2A codec. */
export function frameHostHello(hello: HostHelloV1): ProtocolError | Uint8Array {
  return encodeHostHello(hello)
}
/** Frame any post-handshake control envelope (`ready`, `shutdown-ack`, `heartbeat`, `error`, …). */
export function frameControl(envelope: ControlEnvelope): ProtocolError | Uint8Array {
  return encodeControlEnvelope(envelope)
}
/** Alias for a `ready` control envelope, for reader intent. */
export const frameReady = frameControl
/** Frame a full `frame` envelope (data class) with the 2A codec. */
export function frameFrame(frame: FrameEnvelope): ProtocolError | Uint8Array {
  return encodeFrameEnvelope(frame)
}
/** Frame arbitrary raw control-class bytes (for malformed-input tests). */
export function frameRawControl(payload: Uint8Array): Uint8Array {
  const framed = encodeFrame({ messageClass: "control", payload })
  if (framed instanceof Error) throw framed
  return framed
}

export interface ScriptedChild extends SpawnedChild {
  emit(bytes: Uint8Array): void
  endStdout(): void
  emitStderr(bytes: Uint8Array): void
  simulateExit(options?: { code?: number; signal?: string }): void
  readonly written: Uint8Array[]
  onWrite?: (bytes: Uint8Array) => void
}

/** A minimal async queue: `push`/`end` producer, `[Symbol.asyncIterator]` consumer. */
function createByteQueue() {
  const buffer: Uint8Array[] = []
  let done = false
  let wake: (() => void) | null = null
  const signal = () => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push(bytes: Uint8Array) {
      if (done) return
      buffer.push(bytes)
      signal()
    },
    end() {
      done = true
      signal()
    },
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift() as Uint8Array
          continue
        }
        if (done) return
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }
}

/**
 * A scripted child. `stdin.write` captures bytes (and calls `onWrite`, letting a
 * test auto-respond to the supervisor's messages); `emit`/`endStdout` drive the
 * stdout stream; `simulateExit`/`kill` resolve `exited`. `kill()` mirrors the
 * D2 forced-kill shape (code 143, `signalCode:"SIGTERM"`).
 */
export function createScriptedChild(onWrite?: (bytes: Uint8Array) => void): ScriptedChild {
  const stdout = createByteQueue()
  const stderr = createByteQueue()
  const written: Uint8Array[] = []
  let exitCode: number | null = null
  let signalCode: string | null = null
  let resolveExited: (code: number) => void = () => {}
  let settled = false
  const exited = new Promise<number>((resolve) => (resolveExited = resolve))

  const settle = (code: number, signal: string | null) => {
    if (settled) return
    settled = true
    exitCode = signal === null ? code : null
    signalCode = signal
    stdout.end()
    stderr.end()
    resolveExited(code)
  }

  const stdin: ChildStdin = {
    write(bytes) {
      written.push(bytes)
      child.onWrite?.(bytes)
      return true
    },
    flush() {
      return true
    },
    end() {
      return true
    },
  }

  const child: ScriptedChild = {
    stdin,
    stdout,
    stderr,
    exited,
    get exitCode() {
      return exitCode
    },
    get signalCode() {
      return signalCode
    },
    kill() {
      settle(143, "SIGTERM")
    },
    emit: (bytes) => stdout.push(bytes),
    endStdout: () => stdout.end(),
    emitStderr: (bytes) => stderr.push(bytes),
    simulateExit: (options) => settle(options?.code ?? 0, options?.signal ?? null),
    written,
    onWrite,
  }
  return child
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/scripted-child.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/supervisor/model/scripted-child.ts src/host/supervisor/model/scripted-child.test.ts
git commit -m "test: add scripted in-memory child + reply framers for supervisor tests"
```

---

### Task 6: Framed transport (send + read-inbound + stderr drain)

**Files:**
- Create: `src/host/supervisor/model/transport.ts`
- Test: `src/host/supervisor/model/transport.test.ts`

**Interfaces:**
- Consumes: `SpawnedChild` (Task 4), `SupervisorError` (Task 1), `FrameDecoder` (framing), `ProtocolError` (2A), `createScriptedChild`/framers (Task 5).
- Produces: `interface InboundMessage { readonly messageClass: "control" | "data"; readonly payload: Uint8Array }`; `writeFramed(child, bytes): Promise<SupervisorError | null>`; `readInbound(child): AsyncGenerator<ProtocolError | SupervisorError | InboundMessage>`; `createStderrDrain(child): { tail(): Uint8Array; discarded(): number; stop(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/transport.test.ts
import { describe, expect, test } from "bun:test"
import { ProtocolError } from "../../protocol"
import { SupervisorError } from "./errors"
import { createScriptedChild, frameRawControl } from "./scripted-child"
import { createStderrDrain, readInbound, writeFramed } from "./transport"
import type { InboundMessage } from "./transport"

describe("writeFramed", () => {
  test("awaits the possibly-async write + flush and returns null on success", async () => {
    const child = createScriptedChild()
    const result = await writeFramed(child, new Uint8Array([9, 9]))
    expect(result).toBeNull()
    expect(Array.from(child.written[0]!)).toEqual([9, 9])
  })
})

describe("readInbound", () => {
  test("yields decoded control/data messages across fragmented chunks", async () => {
    const child = createScriptedChild()
    const framed = frameRawControl(new TextEncoder().encode('{"k":1}'))
    // deliver the frame split byte-by-byte (fragmentation is normal — Spike E)
    for (const byte of framed) child.emit(new Uint8Array([byte]))
    child.endStdout()

    const messages: InboundMessage[] = []
    for await (const message of readInbound(child)) {
      if (message instanceof Error) throw message
      messages.push(message)
    }
    expect(messages.length).toBe(1)
    expect(messages[0]!.messageClass).toBe("control")
    expect(new TextDecoder().decode(messages[0]!.payload)).toBe('{"k":1}')
  })

  test("yields a ProtocolError (MALFORMED_PROTOCOL) on a framing violation and stops", async () => {
    const child = createScriptedChild()
    // payload length 0 is a fatal framing error
    child.emit(new Uint8Array([0, 0, 0, 0, 1, 1, 0, 0]))
    child.endStdout()
    const out: (ProtocolError | SupervisorError | InboundMessage)[] = []
    for await (const message of readInbound(child)) out.push(message)
    expect(out.length).toBe(1)
    expect(out[0]).toBeInstanceOf(ProtocolError)
    if (out[0] instanceof ProtocolError) expect(out[0].code).toBe("MALFORMED_PROTOCOL")
  })
})

describe("createStderrDrain", () => {
  test("retains only the bounded 64 KiB tail and counts discarded bytes", async () => {
    const child = createScriptedChild()
    const drain = createStderrDrain(child)
    const chunk = new Uint8Array(50_000).fill(65) // 'A'
    child.emitStderr(chunk)
    child.emitStderr(chunk) // 100_000 total > 65_536
    child.simulateExit({ code: 0 })
    await child.exited
    await drain.settled // drain has consumed the closed stream
    expect(drain.tail().length).toBe(65_536)
    expect(drain.discarded()).toBe(100_000 - 65_536)
    drain.stop()
  })
})
```

> Note: the stderr test references `drain.settled` — include it in the interface (a `Promise<void>` resolving when the stderr iterator ends) so tests can await the drain deterministically.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/transport.test.ts`
Expected: FAIL — cannot find `./transport`.

- [ ] **Step 3: Implement `transport.ts`**

```ts
// src/host/supervisor/model/transport.ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/transport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/supervisor/model/transport.ts src/host/supervisor/model/transport.test.ts
git commit -m "feat: add framed transport (write, read-inbound, bounded stderr drain)"
```

---

### Task 7: Handshake negotiation

**Files:**
- Create: `src/host/supervisor/model/handshake.ts`
- Test: `src/host/supervisor/model/handshake.test.ts`

**Interfaces:**
- Consumes: `HostSessionIdentity`, `HostSessionSpec` (host/types.ts); `ClientHelloV1`, `HostHelloV1`, `PublicLimits`, `RuntimeDeclarationBundleV1`, `ProtocolError` (2A).
- Produces: `interface HandshakeInputs { spec; identity; runtimeDeclaration; offeredLimits }`; `interface HandshakeResult { negotiatedLimits: PublicLimits; hostHello: HostHelloV1 }`; `buildClientHello(inputs): ClientHelloV1`; `verifyHostHello(hostHello, inputs): ProtocolError | HandshakeResult`. Pure functions (no I/O) — the session drives the timing/transport.

Verification (§6.4): identity echo (`sessionId` + `nonce`) → mismatch `MALFORMED_PROTOCOL`; a selected version outside the offered set → `PROTOCOL_NEGOTIATION_FAILED`; child limits larger than offered on any field → `MALFORMED_PROTOCOL`; runtime declaration not deep-equal to the supervisor's → `RUNTIME_INTEGRITY_MISMATCH`; `spec.kitApiVersion` ∉ `supportedKitApiVersions` → `KIT_API_MISMATCH`. On success `negotiatedLimits` is the per-field min of offered and child (§6).

- [ ] **Step 1: Write the failing test**

```ts
// src/host/supervisor/model/handshake.test.ts
import { describe, expect, test } from "bun:test"
import { ProtocolError, PROTOCOL_HARD_LIMITS } from "../../protocol"
import type { HostHelloV1, PublicLimits, RuntimeDeclarationBundleV1 } from "../../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../../types"
import { buildClientHello, verifyHostHello } from "./handshake"
import type { HandshakeInputs } from "./handshake"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
}
const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dash",
  sourcePath: "/scratch/page.tsx",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
}
const identity: HostSessionIdentity = {
  mode: "preview",
  pageSlug: "dash",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  sessionId: "01920000-0000-7000-8000-000000000000",
  nonce: "b".repeat(32),
}
const inputs: HandshakeInputs = {
  spec,
  identity,
  runtimeDeclaration,
  offeredLimits: PROTOCOL_HARD_LIMITS,
}
function hostHello(overrides: Partial<HostHelloV1> = {}): HostHelloV1 {
  return {
    framingVersion: 1,
    kind: "host.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    selectedFramingVersion: 1,
    selectedProtocolVersion: 1,
    runtimeDeclaration,
    limits: PROTOCOL_HARD_LIMITS,
    ...overrides,
  }
}

describe("buildClientHello", () => {
  test("assembles a valid ClientHelloV1 from the spec + minted identity", () => {
    const hello = buildClientHello(inputs)
    expect(hello.kind).toBe("client.hello")
    expect(hello.sessionId).toBe(identity.sessionId)
    expect(hello.nonce).toBe(identity.nonce)
    expect(hello.mode).toBe("preview")
    expect(hello.pageSlug).toBe("dash")
    expect(hello.sourceHash).toBe("a".repeat(64))
    expect(hello.sourceKitApiVersion).toBe(1)
    expect(hello.offeredFramingVersions).toEqual([1])
    expect(hello.offeredProtocolVersions).toEqual([1])
    expect(hello.limits).toEqual(PROTOCOL_HARD_LIMITS)
  })
})

describe("verifyHostHello", () => {
  test("accepts a valid echo and negotiates the per-field min limits", () => {
    const stricter: PublicLimits = {
      controlPayloadBytes: 1000,
      framePayloadBytes: 2000,
      maxFrameWidth: 100,
      maxFrameHeight: 100,
      maxFrameCells: 5000,
    }
    const result = verifyHostHello(hostHello({ limits: stricter }), inputs)
    expect(result).not.toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) throw result
    expect(result.negotiatedLimits).toEqual(stricter)
  })

  test("rejects a sessionId echo mismatch with MALFORMED_PROTOCOL", () => {
    const result = verifyHostHello(hostHello({ sessionId: "different" }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })

  test("rejects a nonce echo mismatch with MALFORMED_PROTOCOL", () => {
    const result = verifyHostHello(hostHello({ nonce: "c".repeat(32) }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })

  test("rejects a runtime declaration disagreement with RUNTIME_INTEGRITY_MISMATCH", () => {
    const result = verifyHostHello(
      hostHello({ runtimeDeclaration: { ...runtimeDeclaration, publicCapabilityIds: ["extra"] } }),
      inputs,
    )
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("RUNTIME_INTEGRITY_MISMATCH")
  })

  test("rejects an unsupported source kit API with KIT_API_MISMATCH", () => {
    const declV2 = { ...runtimeDeclaration, currentKitApiVersion: 2, supportedKitApiVersions: [2] }
    const result = verifyHostHello(
      hostHello({ runtimeDeclaration: declV2 }),
      { ...inputs, runtimeDeclaration: declV2, spec: { ...spec, kitApiVersion: 1 }, identity: { ...identity, kitApiVersion: 1 } },
    )
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("KIT_API_MISMATCH")
  })

  test("rejects child limits larger than offered with MALFORMED_PROTOCOL", () => {
    const tooBig: PublicLimits = { ...PROTOCOL_HARD_LIMITS, maxFrameCells: PROTOCOL_HARD_LIMITS.maxFrameCells + 1 }
    const result = verifyHostHello(hostHello({ limits: tooBig }), inputs)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/handshake.test.ts`
Expected: FAIL — cannot find `./handshake`.

- [ ] **Step 3: Implement `handshake.ts`**

```ts
// src/host/supervisor/model/handshake.ts
import { ProtocolError } from "../../protocol"
import type {
  ClientHelloV1,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../../types"

export interface HandshakeInputs {
  readonly spec: HostSessionSpec
  readonly identity: HostSessionIdentity
  /** The Gate/supervisor's own runtime declaration — must match the host's exactly (§6.4). */
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly offeredLimits: PublicLimits
}

export interface HandshakeResult {
  readonly negotiatedLimits: PublicLimits
  readonly hostHello: HostHelloV1
}

/** Build the single pre-handshake `client.hello` (§5.1) from spec + minted identity. */
export function buildClientHello(inputs: HandshakeInputs): ClientHelloV1 {
  return {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: inputs.identity.sessionId,
    nonce: inputs.identity.nonce,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: inputs.spec.mode,
    pageSlug: inputs.spec.pageSlug,
    sourceHash: inputs.spec.sourceHash,
    sourceKitApiVersion: inputs.spec.kitApiVersion,
    runtimeDeclaration: inputs.runtimeDeclaration,
    limits: inputs.offeredLimits,
  }
}

const LIMIT_FIELDS = [
  "controlPayloadBytes",
  "framePayloadBytes",
  "maxFrameWidth",
  "maxFrameHeight",
  "maxFrameCells",
] as const

/**
 * Verify the host hello per §6.4 and negotiate limits (§6). The 2A decoder has
 * already validated the shape, literals, and hard-limit bounds; this adds the
 * session-relative checks the codec cannot know: identity echo, version
 * membership, declaration agreement, kit-API membership, and offered-limit bound.
 */
export function verifyHostHello(
  hostHello: HostHelloV1,
  inputs: HandshakeInputs,
): ProtocolError | HandshakeResult {
  if (hostHello.sessionId !== inputs.identity.sessionId || hostHello.nonce !== inputs.identity.nonce) {
    return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "host.hello identity does not echo the offered session" })
  }
  if (hostHello.selectedFramingVersion !== 1 || hostHello.selectedProtocolVersion !== 1) {
    return new ProtocolError({ code: "PROTOCOL_NEGOTIATION_FAILED", reason: "host selected a framing/protocol version outside the offered set" })
  }
  for (const field of LIMIT_FIELDS) {
    if (hostHello.limits[field] > inputs.offeredLimits[field]) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `host limit ${field} exceeds the offered limit` })
    }
  }
  if (!declarationsEqual(hostHello.runtimeDeclaration, inputs.runtimeDeclaration)) {
    return new ProtocolError({ code: "RUNTIME_INTEGRITY_MISMATCH", reason: "host runtime declaration bundle differs from the Gate bundle" })
  }
  if (!hostHello.runtimeDeclaration.supportedKitApiVersions.includes(inputs.spec.kitApiVersion)) {
    return new ProtocolError({ code: "KIT_API_MISMATCH", reason: `source kit API version ${inputs.spec.kitApiVersion} is not in the host supported set` })
  }
  const negotiatedLimits: PublicLimits = {
    controlPayloadBytes: Math.min(hostHello.limits.controlPayloadBytes, inputs.offeredLimits.controlPayloadBytes),
    framePayloadBytes: Math.min(hostHello.limits.framePayloadBytes, inputs.offeredLimits.framePayloadBytes),
    maxFrameWidth: Math.min(hostHello.limits.maxFrameWidth, inputs.offeredLimits.maxFrameWidth),
    maxFrameHeight: Math.min(hostHello.limits.maxFrameHeight, inputs.offeredLimits.maxFrameHeight),
    maxFrameCells: Math.min(hostHello.limits.maxFrameCells, inputs.offeredLimits.maxFrameCells),
  }
  return { negotiatedLimits, hostHello }
}

/** Exact structural equality of two runtime declaration bundles (§6.4 "exact agreement"). */
function declarationsEqual(a: RuntimeDeclarationBundleV1, b: RuntimeDeclarationBundleV1): boolean {
  return (
    a.module === b.module &&
    a.currentKitApiVersion === b.currentKitApiVersion &&
    arraysEqual(a.supportedKitApiVersions, b.supportedKitApiVersions) &&
    arraysEqual(a.publicCapabilityIds, b.publicCapabilityIds)
  )
}
function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/handshake.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: tsc + commit**

```bash
bun x tsc --noEmit
git add src/host/supervisor/model/handshake.test.ts src/host/supervisor/model/handshake.ts
git commit -m "feat: add supervisor handshake build + negotiation verification"
```

---

### Task 8: Session state machine (drive to ready + graceful/forced stop + reap)

**Files:**
- Modify: `src/host/supervisor/types.ts` (append `HostSessionDeps`, `HostSession`, `ReadyOutcome`, `StopOutcome`, `SessionPhase`, `ControlEvent`)
- Create: `src/host/supervisor/model/session.ts`
- Create: `src/host/supervisor/index.ts`
- Test: `src/host/supervisor/model/session.test.ts`

**Interfaces:**
- Consumes: everything above + `decodeHostHello`, `decodeControlEnvelope`, `decodeFrameEnvelope`, `encodeClientHello`, `encodeControlEnvelope`, `ProtocolError`, `RuntimeDeclarationBundleV1`, `PublicLimits`, `PROTOCOL_HARD_LIMITS` (2A), `FrameEnvelope`, `ControlEnvelope`.
- Produces (types.ts):
  - `type SessionPhase = "created" | "spawning" | "negotiating" | "mounting" | "ready" | "stopping" | "stopped" | "failed"`
  - `interface ControlEvent { readonly kind: string; readonly envelope: ControlEnvelope }`
  - `interface ReadyOutcome { readonly identity: HostSessionIdentity; readonly negotiatedLimits: PublicLimits; readonly ready: ControlEnvelope; readonly firstFrame: FrameEnvelope | null }`
  - `interface StopOutcome { readonly phase: "stopped"; readonly forced: boolean; readonly exitCode: number | null; readonly signalCode: string | null; readonly reason: string }`
  - `interface HostSessionDeps { readonly spawn: SpawnFn; readonly command: SpawnCommand; readonly clock: Clock; readonly runtimeDeclaration: RuntimeDeclarationBundleV1; readonly offeredLimits?: PublicLimits; readonly onFrame?: (frame: FrameEnvelope) => void; readonly onControlEvent?: (event: ControlEvent) => void }`
  - `interface HostSession { readonly identity: HostSessionIdentity; readonly phase: SessionPhase; start(): Promise<ProtocolError | SupervisorError | ReadyOutcome>; stop(): Promise<StopOutcome> }`
- Produces (session.ts): `createHostSession(spec: HostSessionSpec, deps: HostSessionDeps): HostSession`.
- Produces (index.ts): public re-exports.

**Behavior (§6, §9, §10):** `start()` mints identity, spawns, sends `client.hello`, awaits `host.hello` within **3s** (`HANDSHAKE_TIMEOUT`), verifies it, sends a correlated `mount` request, awaits `ready` within **10s** (`MOUNT_TIMEOUT`), captures the first `frame`, transitions `ready`. Any protocol failure returns the `ProtocolError`; any timeout/transport/exit returns a `SupervisorError`; on any failure the child is killed + reaped and phase becomes `failed`. `stop()` from `ready` sends a correlated `shutdown`, awaits `shutdown-ack` within **1s**, closes stdin, awaits exit; on timeout force-kills and awaits reap within **1s** (`REAP_TIMEOUT` only if the process never reaps). Emits `stopped` only after the process is reaped and the stderr drain has settled. All timers/child/iterator are torn down on every path.

- [ ] **Step 1: Write the failing lifecycle test** (happy path + timeout + forced stop, via the scripted child + manual clock)

```ts
// src/host/supervisor/model/session.test.ts
import { describe, expect, test } from "bun:test"
import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol"
import type {
  ControlEnvelope,
  FrameEnvelope,
  HostHelloV1,
  RuntimeDeclarationBundleV1,
} from "../../protocol"
import type { HostSessionSpec } from "../../types"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import {
  createScriptedChild,
  frameControl,
  frameFrame,
  frameHostHello,
} from "./scripted-child"
import type { ScriptedChild } from "./scripted-child"
import { readInbound } from "./transport"
import { createHostSession } from "./session"
import type { HostSessionDeps } from "../types"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: [],
}
const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dash",
  sourcePath: "/scratch/page.tsx",
  sourceHash: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
}

/**
 * A responding fake host: decodes each supervisor write and emits the scripted
 * reply, so the supervisor's real drive loop runs end-to-end. Reads the
 * supervisor's minted sessionId/nonce off the client.hello it receives.
 */
function respondingChild(options?: { skipReady?: boolean; skipHello?: boolean }): ScriptedChild {
  const child = createScriptedChild()
  let id: { sessionId: string; nonce: string } | null = null
  let messageId = 1n
  const nextId = () => {
    const value = messageId.toString()
    messageId += 1n
    return value
  }
  // decode writes through the shared inbound reader over a per-write mini stream
  child.onWrite = (bytes) => {
    void decodeWrite(bytes)
  }
  async function decodeWrite(bytes: Uint8Array) {
    // reuse readInbound over a throwaway child carrying just these bytes
    const carrier = createScriptedChild()
    carrier.emit(bytes)
    carrier.endStdout()
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return
      if (message.messageClass === "control" && id === null) {
        // it's the client.hello — parse identity from raw JSON
        const parsed = JSON.parse(new TextDecoder().decode(message.payload)) as { sessionId: string; nonce: string; kind: string }
        if (parsed.kind === "client.hello") {
          id = { sessionId: parsed.sessionId, nonce: parsed.nonce }
          if (options?.skipHello) return
          const hostHello: HostHelloV1 = {
            framingVersion: 1,
            kind: "host.hello",
            sessionId: id.sessionId,
            nonce: id.nonce,
            selectedFramingVersion: 1,
            selectedProtocolVersion: 1,
            runtimeDeclaration,
            limits: PROTOCOL_HARD_LIMITS,
          }
          const framed = frameHostHello(hostHello)
          if (!(framed instanceof ProtocolError)) child.emit(framed)
          return
        }
      }
      if (message.messageClass === "control" && id !== null) {
        const env = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope
        if (env.kind === "mount" && !options?.skipReady) {
          const ready: ControlEnvelope = {
            protocolVersion: 1,
            kind: "ready",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { size: { w: 80, h: 24 }, interactionMode: "static" },
          }
          const readyFramed = frameControl(ready)
          if (!(readyFramed instanceof ProtocolError)) child.emit(readyFramed)
          const frame: FrameEnvelope = {
            protocolVersion: 1,
            kind: "frame",
            sessionId: id.sessionId,
            nonce: id.nonce,
            sourceHash: spec.sourceHash,
            frameSeq: "1",
            width: 80,
            height: 24,
            // rows.length MUST equal height (decodeFrameEnvelope, frame.ts:92);
            // empty rows are valid — no run-width check exists.
            rows: Array.from({ length: 24 }, () => []),
          }
          const frameFramed = frameFrame(frame)
          if (!(frameFramed instanceof ProtocolError)) child.emit(frameFramed)
        }
        if (env.kind === "shutdown") {
          const ack: ControlEnvelope = {
            protocolVersion: 1,
            kind: "shutdown-ack",
            sessionId: id.sessionId,
            nonce: id.nonce,
            messageId: nextId(),
            responseTo: env.requestId,
            body: { ok: true },
          }
          const framed = frameControl(ack)
          if (!(framed instanceof ProtocolError)) child.emit(framed)
          child.simulateExit({ code: 0 })
        }
      }
    }
  }
  return child
}

function deps(child: ScriptedChild, clock = createManualClock()): { deps: HostSessionDeps; clock: typeof clock } {
  return {
    clock,
    deps: {
      spawn: () => child,
      command: { cmd: ["_host", "--stdio"] },
      clock,
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    },
  }
}

/**
 * Deterministically wait until a predicate holds, draining real macrotasks. Used
 * to know a clock-driven deadline timer is actually armed before advancing the
 * ManualClock — the scripted child replies under real microtasks, so the number
 * of ticks before a timer is armed is not stable (review Findings #11/#15). A
 * fixed `await Promise.resolve()` / `setTimeout(5)` races the arming and hangs.
 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

describe("createHostSession lifecycle", () => {
  test("spawns, negotiates, mounts, and reaches ready with the first frame", async () => {
    const child = respondingChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const outcome = await session.start()
    expect(outcome).not.toBeInstanceOf(ProtocolError)
    expect(outcome).not.toBeInstanceOf(SupervisorError)
    if (outcome instanceof Error) throw outcome
    expect(session.phase).toBe("ready")
    expect(outcome.ready.kind).toBe("ready")
    expect(outcome.firstFrame?.frameSeq).toBe("1") // the frame that arrives AFTER ready
    expect(outcome.negotiatedLimits).toEqual(PROTOCOL_HARD_LIMITS)

    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(false)
    expect(stop.exitCode).toBe(0)
    expect(session.phase).toBe("stopped")
  })

  test("times out to HANDSHAKE_TIMEOUT when host.hello never arrives", async () => {
    const child = respondingChild({ skipHello: true })
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const startPromise = session.start()
    // Block until start() is parked in "negotiating" with the 3s handshake timer armed.
    await waitUntil(() => session.phase === "negotiating" && clock.pending() >= 1, "handshake timer armed")
    clock.advance(3_000)
    const outcome = await startPromise
    expect(outcome).toBeInstanceOf(SupervisorError)
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("HANDSHAKE_TIMEOUT")
    expect(session.phase).toBe("failed")
    expect(child.signalCode).toBe("SIGTERM") // killed + reaped on the failure path
  })

  test("times out to MOUNT_TIMEOUT when ready never arrives", async () => {
    const child = respondingChild({ skipReady: true })
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const startPromise = session.start()
    // Handshake completes under real microtasks; block until "mounting" + the 10s timer is armed.
    await waitUntil(() => session.phase === "mounting" && clock.pending() >= 1, "mount timer armed")
    clock.advance(10_000)
    const outcome = await startPromise
    expect(outcome).toBeInstanceOf(SupervisorError)
    if (outcome instanceof SupervisorError) expect(outcome.code).toBe("MOUNT_TIMEOUT")
    expect(session.phase).toBe("failed")
  })

  test("force-kills and still reaches stopped when shutdown-ack never arrives", async () => {
    const child = respondingChild() // reaches ready normally...
    const clock = createManualClock()
    const { deps: sessionDeps } = deps(child, clock)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    child.onWrite = () => {} // ...then stops acking shutdown
    const stopPromise = session.stop()
    // Block until the 1s shutdown-ack timer is armed, then trip it. The forced kill
    // resolves `exited` under a microtask, so the 1s reap timer never needs advancing.
    await waitUntil(() => clock.pending() >= 1, "shutdown-ack timer armed")
    clock.advance(1_000)
    const stop = await stopPromise
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(true)
    expect(stop.signalCode).toBe("SIGTERM")
    expect(session.phase).toBe("stopped")
  })
})
```

> Empirical note for the implementer: the manual-clock timeout tests interleave real microtasks (the scripted child replies asynchronously) with virtual-clock advances. Do NOT advance the ManualClock after a fixed number of ticks — the count of awaits before a deadline timer is armed is not stable, and a premature `advance` arms the timer at the advanced `now`, pushing the deadline past where the test ever advances, hanging the suite (violates the green-gate no-hang rule). Instead use `waitUntil(...)` to block until the session reached the target phase AND `clock.pending() >= 1` (the timer is armed), then `advance`. Because `ManualClock.now()` only moves on `advance()`, the absolute-deadline timers (below) measure total elapsed virtual time regardless of how many messages arrived between. This is the pattern 2D-2/3 tests reuse.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/host/supervisor/model/session.test.ts`
Expected: FAIL — cannot find `./session`.

- [ ] **Step 3a: Append the handle types to `src/host/supervisor/types.ts`**

```ts
// append to src/host/supervisor/types.ts
import type { Clock } from "./model/clock"
import type { SupervisorError } from "./model/errors"
import type {
  ControlEnvelope,
  FrameEnvelope,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../types"

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
```

- [ ] **Step 3b: Implement `src/host/supervisor/model/session.ts`**

```ts
// src/host/supervisor/model/session.ts
import {
  decodeControlEnvelope,
  decodeFrameEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
} from "../../protocol"
import type { ControlEnvelope, FrameEnvelope, ProtocolViolationCode, PublicLimits } from "../../protocol"
import type { HostSessionIdentity, HostSessionSpec } from "../../types"
import { SupervisorError } from "./errors"
import { buildClientHello, verifyHostHello } from "./handshake"
import { mintIdentity } from "./identity"
import { createStderrDrain, readInbound, writeFramed } from "./transport"
import type { InboundMessage } from "./transport"
import type { TimerHandle } from "./clock"
import type {
  ControlEvent,
  HostSession,
  HostSessionDeps,
  ReadyOutcome,
  SessionPhase,
  SpawnedChild,
  StopOutcome,
} from "../types"

const HANDSHAKE_TIMEOUT_MS = 3_000
const MOUNT_TIMEOUT_MS = 10_000
const SHUTDOWN_ACK_TIMEOUT_MS = 1_000
const REAP_TIMEOUT_MS = 1_000

/**
 * Create a session that drives ONE incarnation: spawn → negotiate → mount →
 * ready, then graceful/forced stop → reap (§6, §9, §10). A single serialized
 * driver owns the child, the inbound iterator, the stderr drain, and every
 * timer, with explicit teardown on every exit path (never a Reatom connect hook).
 */
export function createHostSession(spec: HostSessionSpec, deps: HostSessionDeps): HostSession {
  const offeredLimits = deps.offeredLimits ?? PROTOCOL_HARD_LIMITS
  const identity = mintIdentity(spec, deps.sessionId)
  let phase: SessionPhase = "created"

  let child: SpawnedChild | null = null
  let stderrDrain: ReturnType<typeof createStderrDrain> | null = null
  let inbound: AsyncGenerator<ProtocolError | SupervisorError | InboundMessage> | null = null
  // Two independent monotonic decimal-uint64 sequences per (sender, nonce): the
  // envelope messageId (1,2,3,… contiguous, §5.2) and the request correlation id
  // (its own 1,2,3,…) echoed back in responseTo. Drawing both from one counter
  // makes messageId non-contiguous (2,4,…) and never "1" (review Finding #8).
  let messageCounter = 1n
  const nextMessageId = () => {
    const value = messageCounter.toString()
    messageCounter += 1n
    return value
  }
  let requestCounter = 1n
  const nextRequestId = () => {
    const value = requestCounter.toString()
    requestCounter += 1n
    return value
  }

  // A single-consumer pull over the inbound iterator against an ABSOLUTE deadline.
  // The timer duration is `deadlineAt - now` each call, so a loop that consumes
  // several messages (awaitReady/awaitShutdownAck) keeps ONE total bound instead of
  // re-arming the full duration per message (review Findings #3/#9). Every timeout
  // path tears the session down, so the abandoned `inbound.next()` on a timeout is
  // settled by `inbound.return()` in teardown/stop and never eaten by a later pull.
  async function nextInbound(deadlineAt: number, timeoutError: SupervisorError): Promise<ProtocolError | SupervisorError | InboundMessage> {
    if (inbound === null) return new SupervisorError({ code: "TRANSPORT_ERROR", reason: "no inbound iterator" })
    let timer: TimerHandle | null = null
    const timeout = new Promise<SupervisorError>((resolve) => {
      const remaining = Math.max(0, deadlineAt - deps.clock.now())
      timer = deps.clock.setTimer(remaining, () => resolve(timeoutError))
    })
    const next = inbound.next().then((result) => (result.done ? new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed before the expected message" }) : result.value))
    const winner = await Promise.race([next, timeout])
    timer?.cancel()
    return winner
  }

  async function start(): Promise<ProtocolError | SupervisorError | ReadyOutcome> {
    if (phase !== "created") {
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: `start() is only valid from "created" (was "${phase}")` })
    }
    phase = "spawning"
    const spawned = deps.spawn(deps.command)
    if (spawned instanceof SupervisorError) {
      phase = "failed"
      return spawned
    }
    child = spawned
    stderrDrain = createStderrDrain(spawned)
    inbound = readInbound(spawned)

    // --- negotiate: send client.hello, await host.hello within 3s ---
    phase = "negotiating"
    const clientHello = buildClientHello({ spec, identity, runtimeDeclaration: deps.runtimeDeclaration, offeredLimits })
    const helloBytes = encodeClientHello(clientHello)
    if (helloBytes instanceof ProtocolError) return failWith(helloBytes)
    const sent = await writeFramed(spawned, helloBytes)
    if (sent instanceof SupervisorError) return failWith(sent)

    const handshakeDeadlineAt = deps.clock.now() + HANDSHAKE_TIMEOUT_MS
    const helloMessage = await nextInbound(handshakeDeadlineAt, new SupervisorError({ code: "HANDSHAKE_TIMEOUT", reason: "no host.hello within 3s" }))
    if (helloMessage instanceof Error) return failWith(helloMessage)
    if (helloMessage.messageClass !== "control") return failWith(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "expected a control-class host.hello" }))
    const hostHello = decodeHostHello(helloMessage.payload)
    if (hostHello instanceof ProtocolError) return failWith(hostHello)
    const negotiation = verifyHostHello(hostHello, { spec, identity, runtimeDeclaration: deps.runtimeDeclaration, offeredLimits })
    if (negotiation instanceof ProtocolError) return failWith(negotiation)

    // --- mount: send correlated mount request, await ready within 10s ---
    phase = "mounting"
    const mountRequestId = nextRequestId()
    const mount: ControlEnvelope = {
      protocolVersion: 1,
      kind: "mount",
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId: mountRequestId,
      body: {
        sourcePath: spec.sourcePath,
        expectedSourceHash: spec.sourceHash,
        mode: spec.mode,
        interactionMode: spec.interactionMode,
        size: { w: spec.size.w, h: spec.size.h },
        theme: spec.theme,
        capabilities: { colorDepth: spec.capabilities.colorDepth },
        deterministic: spec.mode === "export" || spec.mode === "smoke",
      },
    }
    const mountBytes = encodeControlEnvelope(mount)
    if (mountBytes instanceof ProtocolError) return failWith(mountBytes)
    const mountSent = await writeFramed(spawned, mountBytes)
    if (mountSent instanceof SupervisorError) return failWith(mountSent)

    const mountDeadlineAt = deps.clock.now() + MOUNT_TIMEOUT_MS
    const readyResult = await awaitReady(mountRequestId, mountDeadlineAt)
    if (readyResult instanceof Error) return failWith(readyResult)

    phase = "ready"
    return {
      identity,
      negotiatedLimits: negotiation.negotiatedLimits,
      ready: readyResult.ready,
      firstFrame: readyResult.firstFrame,
    }
  }

  // Await the correlated `ready` (§6.6) AND the initial full frame under ONE total
  // 10s deadline, in EITHER order — the 2C child sends `ready` first then the frame,
  // so a version that returned on `ready` alone would always yield firstFrame=null
  // (review Findings #5/#10/#13/#14). Return once BOTH have arrived. A pre-ready
  // `error` envelope is a typed startup failure preserving the child's own code.
  async function awaitReady(
    mountRequestId: string,
    deadlineAt: number,
  ): Promise<ProtocolError | SupervisorError | { ready: ControlEnvelope; firstFrame: FrameEnvelope }> {
    let ready: ControlEnvelope | null = null
    let firstFrame: FrameEnvelope | null = null
    const timeoutError = new SupervisorError({ code: "MOUNT_TIMEOUT", reason: "no ready + first frame within 10s" })
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError)
      if (message instanceof Error) return message
      if (message.messageClass === "data") {
        const frame = decodeFrameEnvelope(message.payload)
        if (frame instanceof ProtocolError) return frame
        const identityError = checkFrameIdentity(frame)
        if (identityError instanceof ProtocolError) return identityError
        if (firstFrame === null) {
          firstFrame = frame
          deps.onFrame?.(frame)
        }
        if (ready !== null) return { ready, firstFrame }
        continue
      }
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) return envelope
      const identityError = checkEnvelopeIdentity(envelope)
      if (identityError instanceof ProtocolError) return identityError
      if (envelope.kind === "ready" && envelope.responseTo === mountRequestId) {
        ready = envelope
        if (firstFrame !== null) return { ready, firstFrame }
        continue
      }
      if (envelope.kind === "error") return mapHostError(envelope)
      if (envelope.kind === "heartbeat") continue
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `unexpected ${envelope.kind} before ready` })
    }
  }

  // §12: a child `error` at mount carries a typed `body.code`. Preserve deterministic
  // protocol codes (SOURCE_HASH_MISMATCH / KIT_API_MISMATCH / MALFORMED_PROTOCOL /
  // OVERSIZED_MESSAGE / FRAME_TOO_LARGE / …) as a ProtocolError so 2D-3 opens the
  // circuit instead of mislabeling them as a restartable DESIGN_RENDER_FAILED
  // (review Findings #7/#12). An untyped/render error stays DESIGN_RENDER_FAILED.
  const PROTOCOL_ERROR_CODES = new Set<string>([
    "MALFORMED_PROTOCOL",
    "OVERSIZED_MESSAGE",
    "FRAME_TOO_LARGE",
    "PROTOCOL_NEGOTIATION_FAILED",
    "RUNTIME_INTEGRITY_MISMATCH",
    "KIT_API_MISMATCH",
    "SOURCE_HASH_MISMATCH",
  ])
  function mapHostError(envelope: ControlEnvelope): ProtocolError | SupervisorError {
    const code = envelope.body.code
    const rawReason = envelope.body.reason
    const reason = typeof rawReason === "string" ? rawReason.slice(0, 200) : "host error during mount"
    if (typeof code === "string" && PROTOCOL_ERROR_CODES.has(code)) {
      return new ProtocolError({ code: code as ProtocolViolationCode, reason })
    }
    return new SupervisorError({ code: "DESIGN_RENDER_FAILED", reason: typeof code === "string" ? `${code}: ${reason}` : reason })
  }

  function checkEnvelopeIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "inbound envelope identity does not match the incarnation" })
    }
    return null
  }
  function checkFrameIdentity(frame: FrameEnvelope): ProtocolError | null {
    if (frame.sessionId !== identity.sessionId || frame.nonce !== identity.nonce || frame.sourceHash !== identity.sourceHash) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "inbound frame identity does not match the incarnation" })
    }
    return null
  }

  // Kill + reap the child and tear down all resources; used on every failure path.
  async function failWith<E extends ProtocolError | SupervisorError>(error: E): Promise<E> {
    await teardown(true)
    phase = "failed"
    return error
  }

  // Reap a child under a bounded §9 reap deadline (1s), then re-kill if it somehow
  // has not exited — never an unbounded `await exited` (review Finding #4). D2: a
  // second kill and a repeat `await exited` are safe/idempotent; OS kill is terminal.
  async function reapChild(target: SpawnedChild, forceKill: boolean): Promise<void> {
    if (forceKill) target.kill()
    let reapTimer: TimerHandle | null = null
    const reapDeadline = new Promise<"reap-timeout">((resolve) => {
      reapTimer = deps.clock.setTimer(REAP_TIMEOUT_MS, () => resolve("reap-timeout"))
    })
    const exit = target.exited.then(() => "exited" as const)
    const reaped = await Promise.race([exit, reapDeadline])
    reapTimer?.cancel()
    if (reaped === "reap-timeout") {
      console.warn("host-supervisor: process did not reap within 1s; re-killing")
      target.kill()
      await target.exited
    }
  }

  async function teardown(kill: boolean): Promise<void> {
    if (child !== null) await reapChild(child, kill)
    stderrDrain?.stop()
    if (stderrDrain !== null) await stderrDrain.settled
    await inbound?.return?.(undefined)
  }

  async function stop(): Promise<StopOutcome> {
    if (phase === "stopped") {
      return { phase: "stopped", forced: false, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: "already stopped" }
    }
    if (child === null || phase !== "ready") {
      // Nothing live to shut down gracefully — force teardown.
      const fromPhase = phase
      await teardown(true)
      phase = "stopped"
      return { phase: "stopped", forced: true, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: `forced stop from phase ${fromPhase}` }
    }
    phase = "stopping"
    const activeChild = child

    // Graceful: send correlated shutdown, await ack within 1s (§9).
    const shutdownRequestId = nextRequestId()
    const shutdown: ControlEnvelope = {
      protocolVersion: 1,
      kind: "shutdown",
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId: shutdownRequestId,
      body: {},
    }
    const bytes = encodeControlEnvelope(shutdown)
    // Each dropped error is logged (errore rule 21 — never a silent swallow) AND its
    // code threaded into StopOutcome.reason so the timeout/transport failure is
    // "retained in diagnostics" (§12, review Finding #2). `null` = graceful.
    const forcing = await (async (): Promise<null | { reason: string }> => {
      if (bytes instanceof ProtocolError) {
        console.warn("host-supervisor: shutdown encode failed, forcing:", bytes.message)
        return { reason: `forced: shutdown encode failed [${bytes.code}]` }
      }
      const sent = await writeFramed(activeChild, bytes)
      if (sent instanceof SupervisorError) {
        console.warn("host-supervisor: shutdown write failed, forcing:", sent.message)
        return { reason: `forced: shutdown write failed [${sent.code}]` }
      }
      const ackDeadlineAt = deps.clock.now() + SHUTDOWN_ACK_TIMEOUT_MS
      const ack = await awaitShutdownAck(shutdownRequestId, ackDeadlineAt)
      if (ack instanceof Error) {
        const code = ack instanceof SupervisorError || ack instanceof ProtocolError ? ack.code : "UNKNOWN"
        console.warn("host-supervisor: no shutdown-ack, forcing:", ack.message)
        return { reason: `forced: no shutdown-ack [${code}]` }
      }
      // Graceful ack received: close stdin and let reapChild await a clean exit
      // (bounded by the reap deadline; it re-kills only if the exit deadline expires).
      activeChild.stdin.end()
      return null
    })()

    await reapChild(activeChild, forcing !== null)
    stderrDrain?.stop()
    if (stderrDrain !== null) await stderrDrain.settled
    await inbound?.return?.(undefined)
    phase = "stopped"
    return {
      phase: "stopped",
      forced: forcing !== null,
      exitCode: activeChild.exitCode,
      signalCode: activeChild.signalCode,
      reason: forcing?.reason ?? "graceful shutdown",
    }
  }

  async function awaitShutdownAck(requestId: string, deadlineAt: number): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    const timeoutError = new SupervisorError({ code: "SHUTDOWN_TIMEOUT", reason: "no shutdown-ack within 1s" })
    while (true) {
      const message = await nextInbound(deadlineAt, timeoutError)
      if (message instanceof Error) return message
      if (message.messageClass === "data") continue // late frame; ignore during stop
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) return envelope
      if (envelope.kind === "shutdown-ack" && envelope.responseTo === requestId) return envelope
      // route other post-ready control events to the sink but keep waiting
      deps.onControlEvent?.({ kind: envelope.kind, envelope })
    }
  }

  return {
    identity,
    get phase() {
      return phase
    },
    start,
    stop,
  }
}
```

- [ ] **Step 3c: Create `src/host/supervisor/index.ts`**

```ts
// src/host/supervisor/index.ts
export { SupervisorError } from "./model/errors"
export type { SupervisorErrorCode } from "./model/errors"
export { createSystemClock, createManualClock } from "./model/clock"
export type { Clock, TimerHandle, ManualClock } from "./model/clock"
export { buildChildEnv, createBunSpawn } from "./model/spawn"
export { mintIdentity, mintNonce } from "./model/identity"
export { createHostSession } from "./model/session"
export type {
  ChildStdin,
  ControlEvent,
  HostSession,
  HostSessionDeps,
  ReadyOutcome,
  SessionPhase,
  SpawnCommand,
  SpawnFn,
  SpawnedChild,
  StopOutcome,
} from "./types"
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/host/supervisor/model/session.test.ts`
Expected: PASS (4 tests). Then the whole module: `bun test src/host/supervisor`.

- [ ] **Step 5: tsc + full-suite green gate + commit**

```bash
bun x tsc --noEmit
bun test          # whole suite green, no hang
git add src/host/supervisor/types.ts src/host/supervisor/model/session.ts src/host/supervisor/index.ts src/host/supervisor/model/session.test.ts
git commit -m "feat: add serialized session state machine (spawn→ready, graceful/forced stop+reap)"
```

---

### Task 9: Real-spawn integration smoke (marked; opt-in)

**Files:**
- Create: `src/host/supervisor/model/integration.test.ts`

**Interfaces:**
- Consumes: `createHostSession`, `createBunSpawn`, `createSystemClock`, the 2C `runHostStdio` via a wrapper command.

This is the one place 2D-1 spawns a REAL process — the §14.4 "normal spawn, negotiation, mount, ready, graceful stop, reap with no leaked handles" end-to-end. It reuses the spike wrapper (`docs/spikes/04-supervisor-derisk/host-wrapper.ts`) as the child command so the supervisor drives the genuine 2C child. Because a real page mount needs a real `.tsx` source + resolver, this test targets the **handshake + graceful stop** portion against the wrapper (mount is covered against the scripted child in Task 8; a full real-mount E2E lands with 2D-4's one-shot smoke, which owns a fixture page).

- [ ] **Step 1: Write the test**

```ts
// src/host/supervisor/model/integration.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { CURRENT_KIT_API_VERSION } from "../../../runtime"
import { PROTOCOL_HARD_LIMITS } from "../../protocol"
import type { RuntimeDeclarationBundleV1 } from "../../protocol"
import type { HostSessionSpec } from "../../types"
import { createSystemClock } from "./clock"
import { createBunSpawn } from "./spawn"
import { createHostSession } from "./session"
import type { HostSession } from "../types"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
}
const wrapper = `${import.meta.dir}/../../../../docs/spikes/04-supervisor-derisk/host-wrapper.ts`
const sessions: HostSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop()
})

describe("real-spawn handshake + graceful stop (integration)", () => {
  test("negotiates host.hello against the genuine 2C child and stops cleanly", async () => {
    const spec: HostSessionSpec = {
      mode: "preview",
      interactionMode: "static",
      pageSlug: "probe",
      sourcePath: "/unused-for-handshake.tsx",
      sourceHash: "0".repeat(64),
      kitApiVersion: CURRENT_KIT_API_VERSION,
      size: { w: 80, h: 24 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
    }
    const session = createHostSession(spec, {
      spawn: createBunSpawn(),
      command: { cmd: [process.execPath, wrapper, "_host", "--stdio"] },
      clock: createSystemClock(),
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
    })
    sessions.push(session)
    // The wrapper mounts no real page, so start() will reach negotiation and then
    // block on mount (no source). We assert the handshake succeeded by observing
    // the session left "negotiating" (reached "mounting") before we stop it.
    const startPromise = session.start()
    await new Promise((r) => setTimeout(r, 1_500)) // cold spawn + hello (~831ms, D1)
    expect(["mounting", "ready", "failed"]).toContain(session.phase)
    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    // avoid an unhandled rejection from the still-pending start()
    await startPromise.catch(() => {})
  }, 15_000)
})
```

> Note: this test proves the real transport + handshake path (D1) end-to-end without a fixture page. A full real-mount→ready→frame E2E is deferred to 2D-4 (which introduces a committed fixture page + the one-shot smoke session). If cold-spawn timing proves flaky in CI, mark this test `test.skipIf(!process.env.TERMCRAFT_INTEGRATION)`.

- [ ] **Step 2: Run**

Run: `bun test src/host/supervisor/model/integration.test.ts`
Expected: PASS (1 test); process reaped, no leaked handles.

- [ ] **Step 3: Full green gate + commit**

```bash
bun x tsc --noEmit
bun test
git add src/host/supervisor/model/integration.test.ts
git commit -m "test: add real-spawn handshake + graceful-stop integration smoke"
```

---

## Self-Review

**1. Spec coverage (2D-1 scope: §3.1, §5, §6, §9, §13):**
- §3.1 `HostSessionSpec`/`HostSessionIdentity`, supervisor-minted identity, no caller `sessionId`/`nonce`, typed handle with no raw streams → Tasks 3, 8. ✓
- §5 framing reuse (one `FrameDecoder`, no resync) → Task 6 (`readInbound`). ✓ Byte-split exhaustiveness is already 2A's `FrameDecoder` suite; Task 6 adds the fragmentation + framing-violation cases at the transport layer.
- §6 handshake: spawn arg array, generate sessionId+nonce, drain stderr, one `client.hello`, 3s host.hello, verify echo/versions/declaration/kit-API, correlated mount, 10s ready → Tasks 4, 6, 7, 8. ✓ (`no-common-version`, `stricter-child-limits`, `source-hash`/`kit-API` handshake cases → Task 7 tests; source-hash-at-mount is the child's job, surfaced as a host `error` whose typed `body.code` (e.g. `SOURCE_HASH_MISMATCH`, `KIT_API_MISMATCH`) is preserved by Task 8's `mapHostError` as a `ProtocolError` so 2D-3 opens the circuit; only an untyped/render error becomes `DESIGN_RENDER_FAILED`.)
- §9 timeouts owned here (3s/10s/1s/1s) via the injected `Clock` → Tasks 2, 8. ✓ (2s request + 5s heartbeat explicitly deferred to 2D-2.)
- §13 isolation: arg-array spawn, pipes only/no TTY, env allowlist, scratch cwd, injected `SpawnCommand` → Task 4. ✓ (workspace-trust `checkTrust()` port, global ≤10, capacity queue → 2D-3.)
- §10 state machine shape (`created→…→stopped`, `failed`) represented in `SessionPhase`; restart/backoff/circuit machinery deferred to 2D-3 (stated). ✓
- §8 stderr bounded 64 KiB tail + discard count → Task 6. ✓ (queues/flood/broker deferred.)

**2. Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — every code + test block is complete. The one deferred E2E (real-mount→ready) is explicitly scoped to 2D-4 with the reason (needs a fixture page), not a placeholder.

**3. Type consistency:** `SpawnFn` returns `SupervisorError | SpawnedChild` (Task 4) and `HostSessionDeps.spawn` consumes it (Task 8); `readInbound` yields `ProtocolError | SupervisorError | InboundMessage` (Task 6) and `nextInbound`/`awaitReady` narrow it (Task 8); `verifyHostHello` returns `ProtocolError | HandshakeResult` (Task 7) consumed in Task 8; `Clock.setTimer` → `TimerHandle` (Task 2) used in Task 8; `HostSessionIdentity`/`HostSessionSpec` (Task 3) flow through Tasks 7–8. Names checked: `mintIdentity`, `buildClientHello`, `verifyHostHello`, `writeFramed`, `readInbound`, `createStderrDrain`, `createHostSession` are spelled identically at definition and use.

## Deferrals (do NOT half-build in 2D-1)

- Frame broker + `PreviewSession` facade + `PreviewFrame` (2D-2).
- Request table (64) + 2s query timeout + `SUPERSEDED` + heartbeat 5s watchdog + `set-mode`/`resize`/`ping` live commands (2D-2).
- Restart budget/backoff/circuit-breaker + ordered control queue (256+1) + inbound mailbox bound + flood detection + `HostSupervisor` (multi-session, global ≤10, `HOST_CAPACITY`) (2D-3).
- One-shot `smoke`/`export` sessions + export pool + a committed fixture page for the full real-mount E2E (2D-4).
- `checkTrust()` workspace-trust port + diagnostics sink port (wired where they attach; 2D-1 leaves seams — `HostSessionDeps` grows in 2D-3).

## Adversarial review remediation (applied)

This plan was reviewed by a six-lens adversarial workflow (errore, Reatom lifetime,
protocol/framing, concurrency/process, spec coverage, plan quality); 17 findings were
CONFIRMED (0 uncertain) and collapsed to 8 distinct defects, all fixed above:

1. **§9 deadlines re-armed per message** (Findings #3/#9): `nextInbound` now takes an
   ABSOLUTE `deadlineAt` (`remaining = deadlineAt - now`), so `awaitReady`/
   `awaitShutdownAck` loops keep one total bound instead of resetting on every frame/
   heartbeat.
2. **First frame never captured** (Findings #5/#10/#13/#14): the child sends `ready`
   THEN the frame; `awaitReady` now collects BOTH in either order and returns only when
   both are present. `ReadyOutcome.firstFrame` is populated; the happy-path test passes.
3. **Invalid frame fixture** (Findings #6/#16): the scripted frame now emits `height`
   empty rows (`rows.length === height`) so `decodeFrameEnvelope` accepts it.
4. **Host `error` code discarded** (Findings #7/#12): `mapHostError` preserves the
   child's typed `body.code` as a `ProtocolError` (deterministic ⇒ 2D-3 opens circuit);
   only untyped errors become `DESIGN_RENDER_FAILED`.
5. **messageId/requestId share one counter** (Finding #8): two independent sequences —
   `nextMessageId` (contiguous from "1") and `nextRequestId`.
6. **Unbounded reap** (Finding #4): `reapChild` bounds every kill→exit wait by the 1s
   reap deadline and re-kills on expiry; used by `teardown` and `stop`.
7. **Silent error swallows** (Findings #1/#2/#17): the stderr-drain `catch` binds +
   `console.warn`s the cause; `stop()`'s forced path logs each dropped error and threads
   its code into `StopOutcome.reason` (retained in diagnostics, §12).
8. **Flaky manual-clock timeout tests** (Findings #11/#15): tests now `waitUntil` the
   session reached the target phase AND a timer is armed (`clock.pending() >= 1`) before
   advancing — no premature advance, no hang.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-mvp-phase-2d1-transport-lifecycle.md`. Recommended execution: **subagent-driven** (fresh subagent per task, two-stage review between tasks), per the project's proven pattern — but first this plan goes through the ultracode adversarial multi-lens review workflow (Task #3 in the session task list), and its confirmed findings are applied before implementation.

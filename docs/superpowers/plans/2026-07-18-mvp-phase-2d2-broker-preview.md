# Phase 2D-2 — Frame Broker / PreviewSession Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before touching code (CLAUDE.md mandate).

**Goal:** Turn the single-shot 2D-1 supervisor session (drives ONE incarnation to `ready` then stops) into a *live* preview session: a capacity-1 latest-wins frame broker with §10.1 stale guards, a 64-entry request table (2 s `QUERY_TIMEOUT` / `SUPERSEDED` / `TOO_MANY_REQUESTS`), a heartbeat/liveness watchdog (5 s `HEARTBEAT_TIMEOUT`; 3 request timeouts in 10 s ⇒ unresponsive), a single-reader post-`ready` pump inside the session, and the `PreviewSession` facade subset the 2C child actually supports.

**Architecture:** Option A from the design brief — after `ready`, the session runs ONE pump loop that is the sole reader of the inbound iterator for the whole `ready → stopped` lifetime. Data frames flow to an internal frame broker (non-blocking atomic replace); envelopes carrying `responseTo` resolve entries in a request table; `heartbeat` feeds a watchdog; everything else routes to `onControlEvent`. `stop()` no longer reads inbound itself — it registers a correlated `shutdown` in the request table and awaits the pump's routing of `shutdown-ack`. The `PreviewSession` facade owns a `HostSession` plus these components and exposes a typed UI-facing subset.

**Tech Stack:** Bun (`bun test`, `bun x tsc --noEmit`), TypeScript 7 (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `errore` (errors as values), the injected `Clock`/`ManualClock` seam, and the 2A protocol codecs. The host/supervisor module is deliberately non-Reatom (closure-based protocol driver + codecs); no atoms are introduced.

## Global Constraints

- **Primary spec:** `docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` §3.2, §7, §8, §9, §10.1.
- **Depends on 2D-1** (`969f59c..3defd21`): consumes `readInbound`/`writeFramed`/`createStderrDrain` (`transport.ts`), the handshake, the session state machine (`session.ts`), the injected `Clock` (`clock.ts`), the `SupervisorError` family (`errors.ts`), and the 2A codecs (`../../protocol`).
- **errore rules apply** everywhere: `import * as errore from "errore"` only where helpers are used; return errors as values (`SupervisorError | ProtocolError | T` unions), check `instanceof Error`, one-line early returns, flat control flow, never a silent swallow (log any dropped error). No `throw` for expected failures.
- **CLAUDE.md module shape:** code lives in `model/`; `types.ts`/`index.ts` sit at the module root. New broker/request-table/watchdog/preview-session files go under `src/host/supervisor/model/`.
- **Green after every task:** `bun test` (whole suite) + `bun x tsc --noEmit` both clean, and `bun test` must return to the shell (no hang) — the 2D-1 discipline.
- **`ManualClock` for every timer test.** Real-microtask races are stabilized with the existing `waitUntil(predicate, label)` helper pattern (`session.test.ts`), never a fixed `setTimeout`/`Promise.resolve` tick count.
- **Do NOT half-build the deferred surface** (2D-3/2D-4): the ordered outbound control queue (256+1) + `HOST_BACKPRESSURED`/`preview.writable`; the inbound control mailbox bound (256+1) + `CONTROL_BACKPRESSURE`; flood detection (`PROTOCOL_FLOOD`/`STDERR_FLOOD`); the restart budget/backoff/circuit + `HostSupervisor`; `forwardInput`/`setTweak`/`setTheme`/`setCapabilities`/geometry `query`/`capture`/`FrameToken`/`GeometryToken`. The facade methods for these are NOT built; `retry()` is a stub until 2D-3.

---

## Decisions & deviations from the design brief

These are the concrete calls this plan makes where the brief left a choice open or under-specified. **The ultracode adversarial plan-review runs against this plan and must ratify or redirect each one before execution.**

1. **`unresponsive` outcome reuses the existing `QUERY_TIMEOUT` code, not a new `UNRESPONSIVE` code.** The 2D-1 `SupervisorErrorCode` union is a *closed vocabulary* (`errors.ts` header comment; ledger line 181 — "no new error type") and contains no `UNRESPONSIVE` member. The watchdog's 3-in-10 s escalation fires `onUnhealthy(new SupervisorError({ code: "QUERY_TIMEOUT", reason: "unresponsive: 3 request timeouts within 10s" }))`. This is truthful (the child is unresponsive *to queries*) and is unambiguous **by channel**: an individual `QUERY_TIMEOUT` only ever *resolves a request* (returned from the request table to its caller) and never reaches `onFatal`; only the watchdog escalation reaches `onFatal`. 2D-3's restart classifier distinguishes them by channel, not code. *Alternative for the reviewer:* add an `UNRESPONSIVE` member to the union (mechanically trivial, `errors.test.ts` does not enumerate the union) if a distinct code is judged worth breaking the "closed vocabulary" for.

2. **Fatal pump/watchdog outcomes are surfaced via an injected `onFatal(error)` deps seam, not a `PreviewLifecycleEvent` union.** The brief §2 listed a `PreviewLifecycleEvent` union in `host/types.ts`, but nothing in 2D-2 scope *consumes* an event stream — the facade (§3.2) exposes no lifecycle-event channel (that is Kernel-Events territory, deferred). YAGNI: adding an unread union is half-building. Fatal outcomes are observable three ways in 2D-2: (a) `HostSession.phase === "failed"`, (b) the broker's `frames` iterator ends, (c) the new `onFatal?: (error: SupervisorError | ProtocolError) => void` deps callback the future 2D-3 supervisor injects. `onFatal` carries the typed error — that is the "typed result/event" invariant 6 asks for. **Correction applied after plan-review:** for channel (b) to hold on a PRE-`ready` startup failure, `teardown()` and the spawn-failure early return now close the broker on every exit path (T4 §4g/§4h), and the facade logs a dropped startup error when no `onFatal` sink is injected (T5) — so `frames` always ends and the error is never silently swallowed.

3. **The facade tracks and exposes `interactionMode`.** §3.2's literal `PreviewSession` has `mode: "preview" | "historical"` (the constant *host* mode) and `setMode(InteractionMode)` (which changes the *interaction* mode: `static` | `interactive`), but no interaction-mode getter — because §7's "mode atoms" are Kernel-side and deferred. To make "mode changes only on an accepted response" (§7) observable and testable in 2D-2, the facade holds the effective interaction mode itself and exposes `readonly interactionMode: InteractionMode`. This is the 2D-2 stand-in for the Kernel mode-atom projection.

4. **Broker/request-table/watchdog are injected as *factories* on `HostSessionDeps`, default-constructed.** The brief §2 says "grow `HostSessionDeps` with broker/requestTable/watchdog seams (default-constructed)". Because the broker's §10.1 guard needs the incarnation identity (`sessionId`/`nonce`/`sourceHash`) that is minted *inside* `createHostSession`, a pre-constructed instance cannot be injected. Instead `HostSessionDeps` gains optional factory functions (`createBroker`/`createRequestTable`/`createWatchdog`) that default to the real constructors; the session builds the instances internally right after minting identity. Tests inject spy factories.

5. **`sendRequest` enforces `TOO_MANY_REQUESTS` before send via an exported `REQUEST_TABLE_CAPACITY` constant.** The brief's `register(): Promise<...>` cannot signal "full" *before* the caller writes to the child if the caller must `await` it. The session's request senders check `requestTable.size() >= REQUEST_TABLE_CAPACITY` synchronously and bail before writing; the table's `register` re-checks internally as defense-in-depth (returns `TOO_MANY_REQUESTS` without reserving a slot).

---

## File Structure

| File | Responsibility | New? | Task |
|---|---|---|---|
| `src/host/types.ts` | + `PreviewFrame` (immutable displayed-frame value, §3.2/§5.3), `PreviewIdentity = Omit<HostSessionIdentity,"nonce">` | modify | T1 |
| `src/host/index.ts` | re-export `PreviewFrame`, `PreviewIdentity` | modify | T1 |
| `src/host/supervisor/model/frame-broker.ts` | capacity-1 latest-wins broker; §10.1 stale guard (session+nonce+sourceHash+monotonic `frameSeq`); `framesCoalesced`; `frames` AsyncIterable of `PreviewFrame`; `close()` ends the iterator | create | T1 |
| `src/host/supervisor/model/frame-broker.test.ts` | broker unit suite | create | T1 |
| `src/host/supervisor/model/request-table.ts` | 64-entry table; `register`→`TOO_MANY_REQUESTS` when full; 2 s `QUERY_TIMEOUT` via `Clock`; `resolve(responseTo)`; `supersede`→`SUPERSEDED`; `clear(error?)` on teardown; `onTimeout` feeds the watchdog; exported `REQUEST_TABLE_CAPACITY` | create | T2 |
| `src/host/supervisor/model/request-table.test.ts` | request-table unit suite | create | T2 |
| `src/host/supervisor/model/heartbeat-watchdog.ts` | 5 s no-valid-heartbeat → `HEARTBEAT_TIMEOUT`; 3 request timeouts in rolling 10 s → unresponsive; `start`/`feedHeartbeat`/`noteRequestTimeout`/`stop`; fires injected `onUnhealthy(SupervisorError)` | create | T3 |
| `src/host/supervisor/model/heartbeat-watchdog.test.ts` | watchdog unit suite | create | T3 |
| `src/host/supervisor/model/session.ts` | **refactor**: add the post-`ready` single-reader pump; refactor `stop()` to correlate `shutdown-ack` through the request table; add `resize`/`setMode`/`ping` request senders; construct broker/table/watchdog from injected factories; expose `frames` + senders on `HostSession` | modify | T4 |
| `src/host/supervisor/model/session.test.ts` | extend with pump/stop-refactor tests | modify | T4 |
| `src/host/supervisor/model/preview-session.ts` | `PreviewSession` facade subset over a `HostSession` | create | T5 |
| `src/host/supervisor/model/preview-session.test.ts` | facade unit suite | create | T5 |
| `src/host/supervisor/types.ts` | + broker/request-table/watchdog/preview-session interfaces; grow `HostSessionDeps` with `onFatal` + factory seams; grow `HostSession` with `frames`/`resize`/`setMode`/`ping` | modify | T1–T5 (touched per task) |
| `src/host/supervisor/index.ts` | re-export `createPreviewSession`, `PreviewSession`, `createFrameBroker`, `FrameBroker`, `createRequestTable`, `RequestTable`, `REQUEST_TABLE_CAPACITY`, `createHeartbeatWatchdog`, `HeartbeatWatchdog` | modify | T1–T5 |
| `.superpowers/sdd/progress.md` | ledger entry | modify | T6 |

**`types.ts` note:** each task adds only the interfaces it needs, so `supervisor/types.ts` is edited in T1 (FrameBroker), T2 (RequestTable), T3 (HeartbeatWatchdog), T4 (HostSessionDeps/HostSession growth), T5 (PreviewSession). This keeps each task's `tsc` green in isolation.

**Import-cycle check (brief open Q4):** `PreviewFrame` lives in `src/host/types.ts` and imports `StyledRun` with `import type { StyledRun } from "./protocol"`. `./protocol` (barrel) imports `HostMode` from `../types` — a type-only cycle. Under `verbatimModuleSyntax` both `import type` edges are fully erased, so there is no runtime cycle and TypeScript resolves the circular *type* graph without error. T1 Step "run tsc" confirms this; if `tsc` ever reported a cycle error the fallback is to move `PreviewFrame` to `supervisor/types.ts`, but this is not expected.

---

### Task 1: `PreviewFrame` value + capacity-1 frame broker

Pure, standalone, no I/O and no clock. Establishes the displayed-frame value type and the latest-wins broker that the pump publishes into.

**Files:**
- Modify: `src/host/types.ts` (add `PreviewFrame`, `PreviewIdentity`)
- Modify: `src/host/index.ts` (re-export the two new types)
- Create: `src/host/supervisor/model/frame-broker.ts`
- Create: `src/host/supervisor/model/frame-broker.test.ts`
- Modify: `src/host/supervisor/types.ts` (add `FrameBroker` interface)
- Modify: `src/host/supervisor/index.ts` (re-export `createFrameBroker`, `FrameBroker`, `PreviewFrame`)

**Interfaces:**
- Consumes: `StyledRun`, `FrameEnvelope` from `../../protocol`; `HostSessionIdentity` from `../../types`.
- Produces:
  - `interface PreviewFrame { readonly sessionId: string; readonly sourceHash: string; readonly frameSeq: string; readonly width: number; readonly height: number; readonly rows: StyledRun[][] }`
  - `type PreviewIdentity = Omit<HostSessionIdentity, "nonce">`
  - `interface FrameBroker { publish(frame: FrameEnvelope): "accepted" | "stale"; readonly frames: AsyncIterable<PreviewFrame>; framesCoalesced(): number; close(): void }`
  - `function createFrameBroker(guard: { sessionId: string; nonce: string; sourceHash: string }): FrameBroker`

- [ ] **Step 1: Add the `PreviewFrame` + `PreviewIdentity` types**

Append to `src/host/types.ts`:

```ts
import type { StyledRun } from "./protocol"

/**
 * An immutable displayed-frame value handed to the UI (host-supervision §3.2/§5.3).
 * It is the frame envelope minus the incarnation `nonce`: the facade's stable
 * identity intentionally omits it so automatic restart (2D-3) does not replace the
 * facade. `frameSeq` is the incarnation-local monotonic decimal-uint64 string.
 */
export interface PreviewFrame {
  readonly sessionId: string
  readonly sourceHash: string
  readonly frameSeq: string
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}

/** The facade's stable identity: the incarnation identity minus the volatile nonce (§3.2). */
export type PreviewIdentity = Omit<HostSessionIdentity, "nonce">
```

Re-export from `src/host/index.ts` (add to the existing `export type { ... } from "./types"` list): `PreviewFrame`, `PreviewIdentity`.

- [ ] **Step 2: Write the failing broker tests**

Create `src/host/supervisor/model/frame-broker.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { FrameEnvelope } from "../../protocol"
import { createFrameBroker } from "./frame-broker"

const GUARD = { sessionId: "s-1", nonce: "a".repeat(32), sourceHash: "b".repeat(64) }

function makeFrame(overrides: Partial<FrameEnvelope> = {}): FrameEnvelope {
  return {
    protocolVersion: 1,
    kind: "frame",
    sessionId: GUARD.sessionId,
    nonce: GUARD.nonce,
    sourceHash: GUARD.sourceHash,
    frameSeq: "1",
    width: 80,
    height: 24,
    rows: Array.from({ length: 24 }, () => []),
    ...overrides,
  }
}

describe("createFrameBroker", () => {
  test("accepts a valid frame and yields it as a PreviewFrame without the nonce", async () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("accepted")
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value, done } = await iterator.next()
    expect(done).toBe(false)
    expect(value).toEqual({
      sessionId: GUARD.sessionId,
      sourceHash: GUARD.sourceHash,
      frameSeq: "1",
      width: 80,
      height: 24,
      rows: Array.from({ length: 24 }, () => []),
    })
    expect(value).not.toHaveProperty("nonce")
  })

  test("capacity-1 latest-wins: replacing an unconsumed frame counts a coalesce", async () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "2" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "3" }))).toBe("accepted")
    expect(broker.framesCoalesced()).toBe(2) // two pending frames were replaced before consumption
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.frameSeq).toBe("3") // only the newest survives
  })

  test("rejects a frame whose nonce, sessionId, or sourceHash does not match the guard (§10.1)", () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ nonce: "f".repeat(32) }))).toBe("stale")
    expect(broker.publish(makeFrame({ sessionId: "s-2" }))).toBe("stale")
    expect(broker.publish(makeFrame({ sourceHash: "c".repeat(64) }))).toBe("stale")
  })

  test("rejects a non-monotonic frameSeq (compared as a uint64, not lexically)", () => {
    const broker = createFrameBroker(GUARD)
    expect(broker.publish(makeFrame({ frameSeq: "9" }))).toBe("accepted")
    expect(broker.publish(makeFrame({ frameSeq: "9" }))).toBe("stale") // equal is not greater
    expect(broker.publish(makeFrame({ frameSeq: "8" }))).toBe("stale") // earlier
    expect(broker.publish(makeFrame({ frameSeq: "10" }))).toBe("accepted") // "10" > "9" numerically, not lexically
  })

  test("close() ends the frame iterator for a parked consumer (§10.1)", async () => {
    const broker = createFrameBroker(GUARD)
    const iterator = broker.frames[Symbol.asyncIterator]()
    const pending = iterator.next() // parks: no frame yet
    broker.close()
    const { done } = await pending
    expect(done).toBe(true)
  })

  test("slow-consumer memory bound: 240 producer frames, 1 pending, 239 coalesced (§8/§14.2)", async () => {
    const broker = createFrameBroker(GUARD)
    for (let seq = 1; seq <= 240; seq += 1) {
      expect(broker.publish(makeFrame({ frameSeq: String(seq) }))).toBe("accepted")
    }
    expect(broker.framesCoalesced()).toBe(239) // only one slot ever retained
    const iterator = broker.frames[Symbol.asyncIterator]()
    const { value } = await iterator.next()
    expect(value?.frameSeq).toBe("240")
  })

  test("publish after close() is stale", () => {
    const broker = createFrameBroker(GUARD)
    broker.close()
    expect(broker.publish(makeFrame({ frameSeq: "1" }))).toBe("stale")
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/host/supervisor/model/frame-broker.test.ts`
Expected: FAIL — `createFrameBroker` is not defined / module not found.

- [ ] **Step 4: Implement the broker**

Create `src/host/supervisor/model/frame-broker.ts`:

```ts
import type { FrameEnvelope } from "../../protocol"
import type { PreviewFrame } from "../../types"
import type { FrameBroker } from "../types"

/**
 * A capacity-1 latest-wins preview frame broker (host-supervision §8, §10.1). It
 * holds at most ONE pending complete frame. `publish` is a non-awaiting atomic
 * replace: a stalled UI consumer can never block lifecycle. Each replace of a
 * still-unconsumed pending frame increments `framesCoalesced`. Every frame is
 * checked against the incarnation guard (session + nonce + source hash) and a
 * strictly-monotonic `frameSeq` before it is accepted; a stale frame is rejected
 * without touching the slot. `close()` ends the frame iterator (§10.1).
 */
export function createFrameBroker(guard: {
  sessionId: string
  nonce: string
  sourceHash: string
}): FrameBroker {
  let pending: PreviewFrame | null = null
  let coalesced = 0
  let lastSeq: bigint | null = null
  let closed = false
  let wake: (() => void) | null = null

  const signal = () => {
    const resume = wake
    wake = null
    resume?.()
  }

  function publish(frame: FrameEnvelope): "accepted" | "stale" {
    if (closed) return "stale"
    if (
      frame.sessionId !== guard.sessionId ||
      frame.nonce !== guard.nonce ||
      frame.sourceHash !== guard.sourceHash
    ) {
      return "stale"
    }
    // frameSeq is a codec-validated decimal-uint64 string, so BigInt() is safe and
    // the comparison is numeric — "10" > "9", which a lexical string compare gets wrong.
    const seq = BigInt(frame.frameSeq)
    if (lastSeq !== null && seq <= lastSeq) return "stale"
    lastSeq = seq
    if (pending !== null) coalesced += 1
    pending = {
      sessionId: frame.sessionId,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    }
    signal()
    return "accepted"
  }

  const frames: AsyncIterable<PreviewFrame> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (closed) return
        if (pending !== null) {
          const frame = pending
          pending = null
          yield frame
          continue
        }
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  }

  return {
    publish,
    frames,
    framesCoalesced: () => coalesced,
    close: () => {
      closed = true
      signal()
    },
  }
}
```

Add to `src/host/supervisor/types.ts` (imports + interface):

```ts
import type { FrameEnvelope } from "../protocol"
import type { PreviewFrame } from "../types"
// ...existing imports...

/** Capacity-1 latest-wins preview frame broker (§8, §10.1). */
export interface FrameBroker {
  /** Atomic capacity-1 replace. Rejects a frame failing the §10.1 identity/seq guard. */
  publish(frame: FrameEnvelope): "accepted" | "stale"
  readonly frames: AsyncIterable<PreviewFrame>
  framesCoalesced(): number
  close(): void
}
```

Re-export from `src/host/supervisor/index.ts`:

```ts
export { createFrameBroker } from "./model/frame-broker"
export type { FrameBroker } from "./types"
export type { PreviewFrame, PreviewIdentity } from "../types"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/host/supervisor/model/frame-broker.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full gate**

Run: `bun test && bun x tsc --noEmit`
Expected: whole suite green (211 + new broker tests), tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/host/types.ts src/host/index.ts src/host/supervisor/model/frame-broker.ts src/host/supervisor/model/frame-broker.test.ts src/host/supervisor/types.ts src/host/supervisor/index.ts
git commit -m "feat(host-2d2): capacity-1 latest-wins frame broker + PreviewFrame value"
```

---

### Task 2: outstanding request table (64 · 2 s `QUERY_TIMEOUT` · `SUPERSEDED` · `TOO_MANY_REQUESTS`)

Correlates supervisor→host requests to their one terminal outcome (§7, §8, §9). Uses the injected `Clock`; fully deterministic under `ManualClock`.

**Files:**
- Create: `src/host/supervisor/model/request-table.ts`
- Create: `src/host/supervisor/model/request-table.test.ts`
- Modify: `src/host/supervisor/types.ts` (add `RequestTable` interface)
- Modify: `src/host/supervisor/index.ts` (re-export)

**Interfaces:**
- Consumes: `Clock` from `./clock`; `ControlEnvelope` from `../../protocol`; `SupervisorError` from `./errors`.
- Produces:
  - `const REQUEST_TABLE_CAPACITY = 64`
  - `interface RequestTable { register(requestId: string, kind: string): Promise<ControlEnvelope | ProtocolError | SupervisorError>; resolve(responseTo: string, envelope: ControlEnvelope): void; supersede(requestId: string, reason: string): void; clear(error?: ProtocolError | SupervisorError): void; size(): number }`
  - `function createRequestTable(clock: Clock, opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number }): RequestTable`

- [ ] **Step 1: Write the failing request-table tests**

Create `src/host/supervisor/model/request-table.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { ControlEnvelope } from "../../protocol"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import { REQUEST_TABLE_CAPACITY, createRequestTable } from "./request-table"

function reply(responseTo: string, kind = "pong"): ControlEnvelope {
  return {
    protocolVersion: 1,
    kind,
    sessionId: "s-1",
    nonce: "a".repeat(32),
    messageId: "9",
    responseTo,
    body: { ok: true },
  }
}

describe("createRequestTable", () => {
  test("register → resolve round-trips the envelope and empties the slot", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "ping")
    expect(table.size()).toBe(1)
    table.resolve("1", reply("1"))
    const result = await pending
    expect(result).not.toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) throw result
    expect(result.responseTo).toBe("1")
    expect(table.size()).toBe(0)
  })

  test("2 s with no response completes the request once with QUERY_TIMEOUT and fires onTimeout", async () => {
    const clock = createManualClock()
    let timeouts = 0
    const table = createRequestTable(clock, { onTimeout: () => (timeouts += 1) })
    const pending = table.register("1", "query-hit")
    clock.advance(2_000)
    const result = await pending
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) expect(result.code).toBe("QUERY_TIMEOUT")
    expect(table.size()).toBe(0)
    expect(timeouts).toBe(1)
  })

  test("supersede completes the request with SUPERSEDED (§7 replaced hover query)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "query-hit")
    table.supersede("1", "replaced by a newer hover")
    const result = await pending
    expect(result).toBeInstanceOf(SupervisorError)
    if (result instanceof SupervisorError) {
      expect(result.code).toBe("SUPERSEDED")
      expect(result.reason).toContain("replaced")
    }
  })

  test("the 65th outstanding register is rejected with TOO_MANY_REQUESTS without reserving a slot (§8)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    for (let i = 1; i <= REQUEST_TABLE_CAPACITY; i += 1) table.register(String(i), "ping")
    expect(table.size()).toBe(REQUEST_TABLE_CAPACITY)
    const overflow = await table.register("65", "ping")
    expect(overflow).toBeInstanceOf(SupervisorError)
    if (overflow instanceof SupervisorError) expect(overflow.code).toBe("TOO_MANY_REQUESTS")
    expect(table.size()).toBe(REQUEST_TABLE_CAPACITY) // unchanged
  })

  test("a late resolve after the timeout is discarded, not a second resolution (§9)", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const pending = table.register("1", "query-hit")
    clock.advance(2_000)
    const timedOut = await pending
    expect(timedOut).toBeInstanceOf(SupervisorError)
    // A response that arrives after the timeout must be a no-op — no throw, no second settle.
    expect(() => table.resolve("1", reply("1"))).not.toThrow()
    expect(table.size()).toBe(0)
  })

  test("resolve for an unknown responseTo is a no-op", () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    expect(() => table.resolve("does-not-exist", reply("does-not-exist"))).not.toThrow()
  })

  test("clear(error) resolves every outstanding request with the given error and cancels their timers", async () => {
    const clock = createManualClock()
    const table = createRequestTable(clock)
    const a = table.register("1", "resize")
    const b = table.register("2", "shutdown")
    table.clear(new SupervisorError({ code: "MOUNT_TIMEOUT", reason: "unused-code-placeholder" }))
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBeInstanceOf(SupervisorError)
    expect(rb).toBeInstanceOf(SupervisorError)
    expect(table.size()).toBe(0)
    expect(clock.pending()).toBe(0) // no leaked query timers
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/host/supervisor/model/request-table.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the request table**

Create `src/host/supervisor/model/request-table.ts`:

```ts
// ProtocolError is type-only here (it flows through the table as a terminal outcome
// when the pump settles a request with a MALFORMED_PROTOCOL identity error).
import type { ControlEnvelope, ProtocolError } from "../../protocol"
import type { RequestTable } from "../types"
import type { Clock, TimerHandle } from "./clock"
import { SupervisorError } from "./errors"

/** Outstanding request table capacity (host-supervision §8). */
export const REQUEST_TABLE_CAPACITY = 64
const QUERY_TIMEOUT_MS = 2_000

interface PendingEntry {
  readonly kind: string
  readonly settle: (result: ControlEnvelope | ProtocolError | SupervisorError) => void
  readonly timer: TimerHandle
}

/**
 * The outstanding request table (host-supervision §7, §8, §9). Every registered
 * request has exactly ONE terminal outcome: a matching `resolve`, a local
 * `supersede` (`SUPERSEDED`), a 2 s `QUERY_TIMEOUT`, or a teardown `clear`. A
 * response for an unknown/already-settled correlation id is discarded. `onTimeout`
 * feeds the heartbeat watchdog's unresponsiveness counter (§9).
 */
export function createRequestTable(
  clock: Clock,
  opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number },
): RequestTable {
  const capacity = opts?.capacity ?? REQUEST_TABLE_CAPACITY
  const timeoutMs = opts?.timeoutMs ?? QUERY_TIMEOUT_MS
  const onTimeout = opts?.onTimeout
  const entries = new Map<string, PendingEntry>()

  function register(requestId: string, kind: string): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    if (entries.size >= capacity) {
      return Promise.resolve(
        new SupervisorError({ code: "TOO_MANY_REQUESTS", reason: `request table full (${capacity})` }),
      )
    }
    if (entries.has(requestId)) {
      return Promise.resolve(
        new SupervisorError({ code: "TRANSPORT_ERROR", reason: `duplicate requestId ${requestId}` }),
      )
    }
    // Bind the resolver to a const outside the executor (the TS7 `never`-narrowing
    // trap the 2D-1 session.ts nextInbound already documents).
    let settle!: (result: ControlEnvelope | ProtocolError | SupervisorError) => void
    const promise = new Promise<ControlEnvelope | ProtocolError | SupervisorError>((resolve) => {
      settle = resolve
    })
    const timer = clock.setTimer(timeoutMs, () => {
      entries.delete(requestId)
      onTimeout?.()
      settle(new SupervisorError({ code: "QUERY_TIMEOUT", reason: `no response for ${kind} within ${timeoutMs}ms` }))
    })
    entries.set(requestId, { kind, settle, timer })
    return promise
  }

  function resolve(responseTo: string, envelope: ControlEnvelope): void {
    const entry = entries.get(responseTo)
    if (entry === undefined) return // late / unknown response — discarded (§9)
    entry.timer.cancel()
    entries.delete(responseTo)
    entry.settle(envelope)
  }

  function supersede(requestId: string, reason: string): void {
    const entry = entries.get(requestId)
    if (entry === undefined) return
    entry.timer.cancel()
    entries.delete(requestId)
    entry.settle(new SupervisorError({ code: "SUPERSEDED", reason }))
  }

  function clear(error?: ProtocolError | SupervisorError): void {
    const terminal =
      error ?? new SupervisorError({ code: "TRANSPORT_ERROR", reason: "request table cleared on teardown" })
    for (const entry of entries.values()) {
      entry.timer.cancel()
      entry.settle(error === undefined ? terminal : error)
    }
    entries.clear()
  }

  return {
    register,
    resolve,
    supersede,
    clear,
    size: () => entries.size,
  }
}
```

Add to `src/host/supervisor/types.ts`:

```ts
import type { SupervisorError } from "./model/errors"
// ...existing imports (ControlEnvelope already imported)...

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
```

Re-export from `src/host/supervisor/index.ts`:

```ts
export { REQUEST_TABLE_CAPACITY, createRequestTable } from "./model/request-table"
export type { RequestTable } from "./types"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/host/supervisor/model/request-table.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full gate**

Run: `bun test && bun x tsc --noEmit`
Expected: green; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/host/supervisor/model/request-table.ts src/host/supervisor/model/request-table.test.ts src/host/supervisor/types.ts src/host/supervisor/index.ts
git commit -m "feat(host-2d2): 64-entry request table (QUERY_TIMEOUT/SUPERSEDED/TOO_MANY_REQUESTS)"
```

---

### Task 3: heartbeat / liveness watchdog (5 s `HEARTBEAT_TIMEOUT`; 3-in-10 s unresponsive)

Owns the §9 liveness bounds on its own `Clock` timer, independent of reads. Fires an injected `onUnhealthy(SupervisorError)`.

**Files:**
- Create: `src/host/supervisor/model/heartbeat-watchdog.ts`
- Create: `src/host/supervisor/model/heartbeat-watchdog.test.ts`
- Modify: `src/host/supervisor/types.ts` (add `HeartbeatWatchdog` interface)
- Modify: `src/host/supervisor/index.ts` (re-export)

**Interfaces:**
- Consumes: `Clock`, `TimerHandle` from `./clock`; `SupervisorError` from `./errors`.
- Produces:
  - `interface HeartbeatWatchdog { start(): void; feedHeartbeat(): void; noteRequestTimeout(): void; stop(): void }`
  - `function createHeartbeatWatchdog(clock: Clock, opts: { onUnhealthy: (error: SupervisorError) => void }): HeartbeatWatchdog`

**Decision reminder (deviations §1):** the unresponsive escalation fires `onUnhealthy` with code `QUERY_TIMEOUT` (reason marks "unresponsive: 3 request timeouts within 10s"); the heartbeat escalation fires code `HEARTBEAT_TIMEOUT`. The watchdog fires **at most once**.

- [ ] **Step 1: Write the failing watchdog tests**

Create `src/host/supervisor/model/heartbeat-watchdog.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import { createHeartbeatWatchdog } from "./heartbeat-watchdog"

function collector() {
  const errors: SupervisorError[] = []
  return { errors, onUnhealthy: (error: SupervisorError) => errors.push(error) }
}

describe("createHeartbeatWatchdog", () => {
  test("5 s with no heartbeat after start() fires HEARTBEAT_TIMEOUT once", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    watchdog.start()
    clock.advance(5_000)
    expect(sink.errors).toHaveLength(1)
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT")
    clock.advance(10_000) // never fires again
    expect(sink.errors).toHaveLength(1)
  })

  test("feedHeartbeat re-arms the 5 s deadline", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    watchdog.start()
    clock.advance(4_000)
    watchdog.feedHeartbeat()
    clock.advance(4_000) // 4 s since the feed — still healthy
    expect(sink.errors).toHaveLength(0)
    clock.advance(1_000) // now 5 s since the feed
    expect(sink.errors).toHaveLength(1)
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT")
  })

  test("noteRequestTimeout does NOT re-arm the heartbeat deadline (frames/queries can't keep a silent host alive, §9)", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    watchdog.start()
    clock.advance(4_000)
    watchdog.noteRequestTimeout() // a query timed out; this must not extend the heartbeat deadline
    clock.advance(1_000) // 5 s since start with no heartbeat
    expect(sink.errors).toHaveLength(1)
    expect(sink.errors[0]?.code).toBe("HEARTBEAT_TIMEOUT")
  })

  test("3 request timeouts within a rolling 10 s window escalate to unresponsive (§9)", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    // Exercise the unresponsive counter in ISOLATION: do NOT start() — that would arm
    // the 5 s heartbeat deadline, which fires during these advances and pre-empts the
    // 3rd timeout via the shared one-shot `fired` flag. Heartbeat timing has its own
    // tests; noteRequestTimeout is independent of the heartbeat deadline.
    watchdog.noteRequestTimeout() // t=0
    clock.advance(3_000)
    watchdog.noteRequestTimeout() // t=3s
    clock.advance(3_000)
    watchdog.noteRequestTimeout() // t=6s — 3 within 10 s
    expect(sink.errors).toHaveLength(1)
    expect(sink.errors[0]?.code).toBe("QUERY_TIMEOUT") // reused code; reason marks "unresponsive"
    expect(sink.errors[0]?.reason).toContain("unresponsive")
  })

  test("request timeouts spread beyond 10 s do NOT escalate (window drops the oldest)", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    // Unresponsive counter in isolation — no start() (see the sibling test's note).
    watchdog.noteRequestTimeout() // t=0
    clock.advance(6_000)
    watchdog.noteRequestTimeout() // t=6s
    clock.advance(6_000) // t=12s — the t=0 stamp is now older than 10 s
    watchdog.noteRequestTimeout() // only 2 within the rolling window (t=6s, t=12s)
    // No unresponsive escalation. (A heartbeat one is possible — feed to keep it clean.)
    expect(sink.errors.filter((e) => e.reason.includes("unresponsive"))).toHaveLength(0)
  })

  test("stop() cancels the heartbeat timer — no fire and no leaked timers", () => {
    const clock = createManualClock()
    const sink = collector()
    const watchdog = createHeartbeatWatchdog(clock, sink)
    watchdog.start()
    watchdog.stop()
    expect(clock.pending()).toBe(0)
    clock.advance(10_000)
    expect(sink.errors).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/host/supervisor/model/heartbeat-watchdog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the watchdog**

Create `src/host/supervisor/model/heartbeat-watchdog.ts`:

```ts
import type { HeartbeatWatchdog } from "../types"
import type { Clock, TimerHandle } from "./clock"
import { SupervisorError } from "./errors"

const HEARTBEAT_TIMEOUT_MS = 5_000
const UNRESPONSIVE_WINDOW_MS = 10_000
const UNRESPONSIVE_THRESHOLD = 3

/**
 * The §9 liveness watchdog. It owns the 5 s "time since last valid heartbeat"
 * bound on its own `Clock` timer, so silence trips it even while stale frame bytes
 * keep arriving — frames never substitute for heartbeats. It also counts request
 * timeouts: three within a rolling 10 s window mark the incarnation unresponsive.
 * It fires the injected `onUnhealthy(SupervisorError)` AT MOST ONCE; the supervisor
 * then runs the same fatal teardown path as any other fatal outcome.
 */
export function createHeartbeatWatchdog(
  clock: Clock,
  opts: { onUnhealthy: (error: SupervisorError) => void },
): HeartbeatWatchdog {
  let heartbeatTimer: TimerHandle | null = null
  let stopped = false
  let fired = false
  const timeoutStamps: number[] = []

  const fire = (error: SupervisorError) => {
    if (fired || stopped) return
    fired = true
    heartbeatTimer?.cancel()
    heartbeatTimer = null
    opts.onUnhealthy(error)
  }

  const armHeartbeat = () => {
    if (stopped || fired) return
    heartbeatTimer?.cancel()
    heartbeatTimer = clock.setTimer(HEARTBEAT_TIMEOUT_MS, () =>
      fire(new SupervisorError({ code: "HEARTBEAT_TIMEOUT", reason: "no valid heartbeat within 5s" })),
    )
  }

  return {
    start: armHeartbeat,
    feedHeartbeat: armHeartbeat,
    noteRequestTimeout() {
      if (stopped || fired) return
      const now = clock.now()
      timeoutStamps.push(now)
      while (timeoutStamps.length > 0 && now - timeoutStamps[0]! > UNRESPONSIVE_WINDOW_MS) {
        timeoutStamps.shift()
      }
      if (timeoutStamps.length >= UNRESPONSIVE_THRESHOLD) {
        fire(
          new SupervisorError({
            code: "QUERY_TIMEOUT",
            reason: `unresponsive: ${UNRESPONSIVE_THRESHOLD} request timeouts within ${UNRESPONSIVE_WINDOW_MS}ms`,
          }),
        )
      }
    },
    stop() {
      stopped = true
      heartbeatTimer?.cancel()
      heartbeatTimer = null
    },
  }
}
```

Add to `src/host/supervisor/types.ts`:

```ts
/** The §9 heartbeat / liveness watchdog. Fires `onUnhealthy` at most once. */
export interface HeartbeatWatchdog {
  start(): void
  feedHeartbeat(): void
  noteRequestTimeout(): void
  stop(): void
}
```

Re-export from `src/host/supervisor/index.ts`:

```ts
export { createHeartbeatWatchdog } from "./model/heartbeat-watchdog"
export type { HeartbeatWatchdog } from "./types"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/host/supervisor/model/heartbeat-watchdog.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full gate**

Run: `bun test && bun x tsc --noEmit`
Expected: green; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/host/supervisor/model/heartbeat-watchdog.ts src/host/supervisor/model/heartbeat-watchdog.test.ts src/host/supervisor/types.ts src/host/supervisor/index.ts
git commit -m "feat(host-2d2): heartbeat/liveness watchdog (5s HEARTBEAT_TIMEOUT + 3-in-10s unresponsive)"
```

---

### Task 4: session post-`ready` pump + `stop()` refactor

The hard task. Modifies `session.ts` to add the single-reader pump and re-route `stop()` through the request table. **Step 0 is a de-risking probe** (brief §5/§6 Q1) that must pass before touching `session.ts`, because this task is the one most likely to bake in a wrong teardown assumption.

**Files:**
- Create (probe, throwaway): `src/host/supervisor/model/pump-probe.test.ts`
- Modify: `src/host/supervisor/model/session.ts`
- Modify: `src/host/supervisor/types.ts` (grow `HostSessionDeps` + `HostSession`)
- Modify: `src/host/supervisor/model/session.test.ts` (extend)
- Modify: `src/host/supervisor/index.ts` (already re-exports session types)

**Interfaces:**
- Consumes: everything T1–T3 produced (`createFrameBroker`/`FrameBroker`, `createRequestTable`/`RequestTable`/`REQUEST_TABLE_CAPACITY`, `createHeartbeatWatchdog`/`HeartbeatWatchdog`), plus `PreviewFrame`, `Size`, `InteractionMode` from `../../types`.
- Produces (grown `HostSession`, consumed by T5):
  - `readonly frames: AsyncIterable<PreviewFrame>`
  - `resize(size: Size): Promise<ControlEnvelope | ProtocolError | SupervisorError>`
  - `setMode(mode: InteractionMode): Promise<ControlEnvelope | ProtocolError | SupervisorError>`
  - `ping(): Promise<ControlEnvelope | ProtocolError | SupervisorError>`
- Produces (grown `HostSessionDeps`):
  - `readonly onFatal?: (error: SupervisorError | ProtocolError) => void`
  - `readonly createBroker?: (guard: { sessionId: string; nonce: string; sourceHash: string }) => FrameBroker`
  - `readonly createRequestTable?: (clock: Clock, opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number }) => RequestTable`
  - `readonly createWatchdog?: (clock: Clock, opts: { onUnhealthy: (error: SupervisorError) => void }) => HeartbeatWatchdog`

- [ ] **Step 0a: Write the de-risking probe (brief §6 Q1/Q2)**

The probe validates, against the scripted child, the exact behaviors the refactor depends on, WITHOUT yet changing `session.ts`. It proves: (1) a bare `for await (const m of inbound)` loop that is the sole reader tears down cleanly when a concurrent watchdog trips `HEARTBEAT_TIMEOUT` — the suspended `inbound.next()` is settled by `inbound.return()` and does not leak; (2) publishing a captured `firstFrame` at pump start reaches the broker.

Create `src/host/supervisor/model/pump-probe.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import type { InboundMessage } from "./transport"
import { readInbound } from "./transport"
import { createManualClock } from "./clock"
import { SupervisorError } from "./errors"
import { createFrameBroker } from "./frame-broker"
import { createHeartbeatWatchdog } from "./heartbeat-watchdog"
import { createScriptedChild, frameControl, frameFrame } from "./scripted-child"
import type { ControlEnvelope, FrameEnvelope } from "../../protocol"

const ID = { sessionId: "s-1", nonce: "a".repeat(32), sourceHash: "b".repeat(64) }

function heartbeat(messageId: string): ControlEnvelope {
  return { protocolVersion: 1, kind: "heartbeat", sessionId: ID.sessionId, nonce: ID.nonce, messageId, body: {} }
}
function frame(frameSeq: string): FrameEnvelope {
  return {
    protocolVersion: 1, kind: "frame", sessionId: ID.sessionId, nonce: ID.nonce, sourceHash: ID.sourceHash,
    frameSeq, width: 80, height: 24, rows: Array.from({ length: 24 }, () => []),
  }
}

describe("pump de-risking probe", () => {
  test("a single-reader for-await pump tears down on HEARTBEAT_TIMEOUT without leaking the suspended next()", async () => {
    const child = createScriptedChild()
    const inbound = readInbound(child)
    const clock = createManualClock()
    const broker = createFrameBroker(ID)

    let fatal: SupervisorError | null = null
    const watchdog = createHeartbeatWatchdog(clock, {
      onUnhealthy: (error) => {
        fatal = error
        // teardown mirror MATCHING finalizeFatalTeardown: kill the child FIRST (ends
        // stdout → the for-await drains to done) THEN inbound.return() (idempotent).
        // Calling inbound.return() while stdout is open-but-idle would hang the reader
        // — exactly the choreography the real teardown avoids by reaping first.
        child.kill()
        void inbound.return?.(undefined)
        broker.close()
        watchdog.stop()
      },
    })

    const framed = frameFrame(frame("1"))
    if (!(framed instanceof Error)) child.emit(framed) // one post-ready frame, then silence

    const pump = (async () => {
      watchdog.start()
      broker.publish(frame("1")) // firstFrame publish at pump start (brief §6 Q2)
      for await (const message of inbound) {
        if (message instanceof Error) return
        if (message.messageClass === "data") continue // broker already has it; probe ignores decode here
        // control frames would dispatch here
      }
    })()

    // Let the pump park in inbound.next(), then trip the 5 s heartbeat deadline.
    await new Promise((resolve) => setTimeout(resolve, 0))
    clock.advance(5_000)
    await pump // must resolve — no hang, no leaked next()

    expect(fatal).not.toBeNull()
    expect((fatal as unknown as SupervisorError | null)?.code).toBe("HEARTBEAT_TIMEOUT")
    expect(clock.pending()).toBe(0)
  })
})
```

- [ ] **Step 0b: Run the probe**

Run: `bun test src/host/supervisor/model/pump-probe.test.ts`
Expected: PASS. If it hangs or `clock.pending()` is non-zero, STOP — the teardown choreography below needs revision before proceeding (record findings; the adversarial plan-review is the place to reconcile). Once green, **delete the probe file** (it is a throwaway — do not commit it), mirroring the 2D-1 `race-repro.test.ts` disposal.

> **De-risk pre-validated (2026-07-18, out-of-band before this plan was committed):** the probe was run once against the *real* `readInbound`/`createScriptedChild`/`createManualClock` seams with the T1/T3 collaborators (broker/watchdog) **inlined verbatim** (their modules did not exist yet) — result **green** (1 pass, `clock.pending() === 0`, `firstPublish === "accepted"`, no hang). Reaping the child *before* `inbound.return()` drains the suspended `next()` cleanly. This step **stays in-plan** and must be re-run during implementation against the *committed* `./frame-broker` and `./heartbeat-watchdog` modules to confirm the choreography holds with the real imports, not just the inlined copies.

```bash
rm src/host/supervisor/model/pump-probe.test.ts
```

- [ ] **Step 1: Grow `HostSessionDeps` and `HostSession` in `supervisor/types.ts`**

Add the imports and fields (the file already imports `ControlEnvelope`, `FrameEnvelope`, `ProtocolError`, `Clock`, `SupervisorError`; add `Size`, `InteractionMode`, `PreviewFrame` from `../types` and the T1–T3 interface names which are already declared in this same file):

```ts
import type { HostSessionIdentity, HostSessionSpec, InteractionMode, PreviewFrame, Size } from "../types"
```

Extend `HostSessionDeps`:

```ts
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
```

Extend `HostSession`:

```ts
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
```

- [ ] **Step 2: Write the failing pump/stop tests (extend `session.test.ts`)**

Extend `respondingChild` to answer post-`ready` requests and emit heartbeats, and add a new `describe` block. Append to `src/host/supervisor/model/session.test.ts`:

```ts
// --- 2D-2: post-ready pump + stop-via-request-table ---

/**
 * Extends the responding fake host with post-ready behavior: it answers `ping`
 * with `pong`, `resize`/`set-mode` with a correlated echo, and can emit a data
 * frame / heartbeat on demand. Built on the same onWrite decode loop.
 */
function livePreviewChild(): ScriptedChild {
  const child = createScriptedChild()
  let id: { sessionId: string; nonce: string } | null = null
  let messageId = 1n
  const nextId = () => {
    const value = messageId.toString()
    messageId += 1n
    return value
  }
  const send = (env: ControlEnvelope) => {
    const framed = frameControl(env)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  child.onWrite = (bytes) => void decode(bytes)
  async function decode(bytes: Uint8Array) {
    const carrier = createScriptedChild()
    carrier.emit(bytes)
    carrier.endStdout()
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return
      if (message.messageClass !== "control") return
      const raw = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope & { kind: string }
      if (raw.kind === "client.hello" && id === null) {
        id = { sessionId: raw.sessionId, nonce: raw.nonce }
        const hostHello: HostHelloV1 = {
          framingVersion: 1, kind: "host.hello", sessionId: id.sessionId, nonce: id.nonce,
          selectedFramingVersion: 1, selectedProtocolVersion: 1, runtimeDeclaration, limits: PROTOCOL_HARD_LIMITS,
        }
        const framed = frameHostHello(hostHello)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (id === null) return
      if (raw.kind === "mount") {
        send({ protocolVersion: 1, kind: "ready", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: { w: 80, h: 24 }, interactionMode: "static" } })
        const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: "1", width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
        const framed = frameFrame(frame)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (raw.kind === "ping") {
        send({ protocolVersion: 1, kind: "pong", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: {} })
        return
      }
      if (raw.kind === "resize") {
        send({ protocolVersion: 1, kind: "resize", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: raw.body.size } })
        return
      }
      if (raw.kind === "set-mode") {
        send({ protocolVersion: 1, kind: "set-mode", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { interactionMode: raw.body.interactionMode } })
        return
      }
      if (raw.kind === "shutdown") {
        send({ protocolVersion: 1, kind: "shutdown-ack", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { ok: true } })
        child.simulateExit({ code: 0 })
        return
      }
    }
  }
  // Helper: emit a post-ready frame / heartbeat once identity is known.
  ;(child as ScriptedChild & { emitFrame(seq: string): void; emitHeartbeat(): void }).emitFrame = (seq) => {
    if (id === null) return
    const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: seq, width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
    const framed = frameFrame(frame)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  ;(child as ScriptedChild & { emitFrame(seq: string): void; emitHeartbeat(): void }).emitHeartbeat = () => {
    if (id === null) return
    send({ protocolVersion: 1, kind: "heartbeat", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), body: {} })
  }
  return child
}

describe("createHostSession post-ready pump (2D-2)", () => {
  test("the firstFrame reaches the broker and post-ready frames stream through it", async () => {
    const child = livePreviewChild() as ScriptedChild & { emitFrame(seq: string): void }
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started

    const iterator = session.frames[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.frameSeq).toBe("1") // the captured firstFrame published at pump start

    child.emitFrame("2")
    const second = await iterator.next()
    expect(second.value?.frameSeq).toBe("2")

    await session.stop()
  })

  test("a correlated ping resolves through the request table", async () => {
    const child = livePreviewChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    const pong = await session.ping()
    expect(pong).not.toBeInstanceOf(SupervisorError)
    if (pong instanceof Error) throw pong
    expect(pong.kind).toBe("pong")
    await session.stop()
  })

  test("a heartbeat feeds the watchdog; 5 s of silence tears down to failed with HEARTBEAT_TIMEOUT", async () => {
    const child = livePreviewChild() as ScriptedChild & { emitHeartbeat(): void }
    const clock = createManualClock()
    const fatals: (SupervisorError | ProtocolError)[] = []
    const base = deps(child, clock).deps
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) })
    const started = await session.start()
    if (started instanceof Error) throw started
    // Arm the 5 s heartbeat deadline (the pump called watchdog.start() at ready).
    await waitUntil(() => clock.pending() >= 1, "heartbeat timer armed")
    clock.advance(5_000)
    // `phase` flips to "failed" SYNCHRONOUSLY inside failFromReady, but onFatal is
    // invoked at the END of the async finalizeFatalTeardown — so wait on `fatals`,
    // NOT on `phase`, or the assertion runs before onFatal fires (deterministic red).
    await waitUntil(() => fatals.length === 1, "onFatal fired after teardown")
    expect(session.phase).toBe("failed")
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("HEARTBEAT_TIMEOUT")
  })

  test("stop() correlates shutdown-ack through the request table (graceful path still works)", async () => {
    const child = livePreviewChild()
    const { deps: sessionDeps } = deps(child)
    const session = createHostSession(spec, sessionDeps)
    const started = await session.start()
    if (started instanceof Error) throw started
    const stop = await session.stop()
    expect(stop.phase).toBe("stopped")
    expect(stop.forced).toBe(false)
    expect(stop.exitCode).toBe(0)
  })

  test("a post-ready frame with a wrong nonce is a fatal MALFORMED_PROTOCOL, not a silent drop (§10.1/§5.3/§12)", async () => {
    const child = livePreviewChild()
    const clock = createManualClock()
    const fatals: (SupervisorError | ProtocolError)[] = []
    const base = deps(child, clock).deps
    const session = createHostSession(spec, { ...base, onFatal: (e) => fatals.push(e) })
    const started = await session.start()
    if (started instanceof Error) throw started
    // The live child (correct identity) emits a frame whose nonce does NOT match this
    // incarnation. With ONE decoder there is no cross-nonce noise — it is a real §10.1
    // violation the pump must fatal, not drop. (A backwards frameSeq is symmetric: the
    // broker returns "stale" on an identity-valid frame → onPumpFatal MALFORMED_PROTOCOL.)
    const forged: FrameEnvelope = {
      protocolVersion: 1, kind: "frame", sessionId: session.identity.sessionId, nonce: "f".repeat(32),
      sourceHash: spec.sourceHash, frameSeq: "2", width: 80, height: 24, rows: Array.from({ length: 24 }, () => []),
    }
    const framed = frameFrame(forged)
    if (framed instanceof ProtocolError) throw framed
    child.emit(framed)
    await waitUntil(() => fatals.length === 1, "pump fataled on the wrong-nonce frame")
    expect(session.phase).toBe("failed")
    expect(fatals[0] instanceof ProtocolError && fatals[0].code).toBe("MALFORMED_PROTOCOL")
  })
})
```

> **Note on the existing 2D-1 suite:** three of the four `createHostSession lifecycle` tests pass **unchanged** — including "rejects a shutdown-ack whose identity echo is wrong and forces the stop": the forged-identity ack is rejected inside the pump, which resolves the outstanding shutdown request with the `MALFORMED_PROTOCOL` error via `requestTable.clear(error)`, so `stop.reason` still contains `"MALFORMED_PROTOCOL"` and `forced` stays `true`, with no 1 s stall (this is why the request table's terminal-outcome union carries `ProtocolError` — Task 2).
>
> The **"force-kills … when shutdown-ack never arrives" test needs ONE edit**: change its arming gate `await waitUntil(() => clock.pending() >= 1, …)` to `await waitUntil(() => clock.pending() >= 3, "shutdown-ack timer armed")`. After the refactor the watchdog's 5 s timer (armed at `ready` by `startPump`) and the request-table's 2 s timer (armed by `requestTable.register(shutdownRequestId, …)`) are BOTH pending before the dedicated 1 s ack timer, so `>= 1` returns on its first synchronous check — before `raceShutdownAck` arms the ack timer — and `clock.advance(1_000)` would fire nothing, hanging the test (no-hang gate violation). Gating on `>= 3` waits until the ack timer is armed (watchdog + table + ack); `advance(1_000)` then fires it → `SHUTDOWN_TIMEOUT` → forced. Apply this one-line change in Step 4. Do not weaken any assertion.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/host/supervisor/model/session.test.ts`
Expected: FAIL — `session.frames`/`session.ping` undefined; the new tests fail to compile/run.

- [ ] **Step 4: Refactor `session.ts` — construct components, add the pump, add senders, re-route stop**

Apply these changes to `src/host/supervisor/model/session.ts`. (The handshake/mount portion of `start()` is unchanged; only the ready transition, `stop()`, and new helpers change.)

**4a. Imports** — add:

```ts
// NOTE: session.ts ALREADY imports decodeControlEnvelope + decodeFrameEnvelope from
// "../../protocol" (top import block, used by awaitReady, retained per §4h) — do NOT
// re-add them here or tsc fails with TS2300 "Duplicate identifier".
import type { InteractionMode, PreviewFrame, Size } from "../../types"
import { createFrameBroker } from "./frame-broker"
import { createRequestTable, REQUEST_TABLE_CAPACITY } from "./request-table"
import { createHeartbeatWatchdog } from "./heartbeat-watchdog"
import type { FrameBroker, HeartbeatWatchdog, RequestTable } from "../types"
```

**4b. Construct broker/table/watchdog** right after `identity` is minted (before `start`):

```ts
  // Post-ready components. The watchdog escalation and the request-table timeout
  // are wired to the single fatal path (declared as hoisted functions below).
  const watchdog: HeartbeatWatchdog = (deps.createWatchdog ?? createHeartbeatWatchdog)(deps.clock, {
    onUnhealthy: (error) => onPumpFatal(error),
  })
  const requestTable: RequestTable = (deps.createRequestTable ?? createRequestTable)(deps.clock, {
    onTimeout: () => watchdog.noteRequestTimeout(),
  })
  const broker: FrameBroker = (deps.createBroker ?? createFrameBroker)({
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    sourceHash: identity.sourceHash,
  })
  let pumpTask: Promise<void> = Promise.resolve()
```

**4c. Start the pump at the `ready` transition.** Replace the tail of `start()`:

```ts
    phase = "ready"
    startPump(readyResult.firstFrame)
    return {
      identity,
      negotiatedLimits: negotiation.negotiatedLimits,
      ready: readyResult.ready,
      firstFrame: readyResult.firstFrame,
    }
```

**4d. The pump + fatal path** (new functions):

```ts
  function startPump(firstFrame: FrameEnvelope): void {
    // Publish the already-captured first frame so the initial displayed frame is
    // not dropped (brief §6 Q2). The broker's guard re-validates it.
    broker.publish(firstFrame)
    watchdog.start()
    pumpTask = runPump()
  }

  // The SOLE reader of `inbound` from `ready` onward (brief invariant 1). A bare
  // for-await with no per-message deadline — liveness is the watchdog's job
  // (brief §6 Q1). Every fatal exit routes through onPumpFatal; teardown settles
  // the suspended next() via inbound.return(), so nothing leaks.
  async function runPump(): Promise<void> {
    if (inbound === null) return
    for await (const message of inbound) {
      if (message instanceof Error) {
        onPumpFatal(message)
        return
      }
      if (message.messageClass === "data") {
        const frame = decodeFrameEnvelope(message.payload)
        if (frame instanceof ProtocolError) {
          onPumpFatal(frame)
          return
        }
        // §10.1/§5.3/§12: a frame's identity + monotonic frameSeq are FATAL for the
        // live child, not a silent drop. 2D-1 awaitReady already enforced
        // checkFrameIdentity fatally; with ONE incarnation there is no cross-nonce
        // noise yet, so a mismatch is a real violation → terminate + MALFORMED_PROTOCOL.
        const frameIdentityError = checkFrameIdentity(frame)
        if (frameIdentityError instanceof ProtocolError) {
          onPumpFatal(frameIdentityError)
          return
        }
        // Identity passed, so a broker "stale" can only be a non-monotonic frameSeq
        // from the current incarnation — also a fatal §5.3 violation, not a drop.
        if (broker.publish(frame) === "stale") {
          onPumpFatal(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `non-monotonic frameSeq ${frame.frameSeq}` }))
          return
        }
        continue
      }
      const envelope = decodeControlEnvelope(message.payload)
      if (envelope instanceof ProtocolError) {
        onPumpFatal(envelope)
        return
      }
      const identityError = checkEnvelopeIdentity(envelope)
      if (identityError instanceof ProtocolError) {
        onPumpFatal(identityError)
        return
      }
      if (envelope.responseTo !== undefined) {
        requestTable.resolve(envelope.responseTo, envelope)
        continue
      }
      if (envelope.kind === "error") {
        onPumpFatal(mapHostError(envelope))
        return
      }
      if (envelope.kind === "heartbeat") {
        watchdog.feedHeartbeat()
        continue
      }
      deps.onControlEvent?.({ kind: envelope.kind, envelope })
    }
    // inbound ended. If we were still ready, the child exited unexpectedly.
    if (phase === "ready") onPumpFatal(new SupervisorError({ code: "CHILD_EXITED", reason: "stdout closed while ready" }))
  }

  // The single fatal entry point for the pump AND the watchdog. It always settles
  // outstanding requests with the exact error (so a concurrent stop() resolves
  // immediately with this code, not a 1 s timeout), then — only if still `ready` —
  // owns the async teardown to `failed`. If we are already stopping/stopped/failed,
  // that path owns teardown.
  function onPumpFatal(error: ProtocolError | SupervisorError): void {
    requestTable.clear(error)
    if (phase === "ready") failFromReady(error)
  }

  function failFromReady(error: ProtocolError | SupervisorError): void {
    if (phase !== "ready") return
    phase = "failed"
    broker.close()
    watchdog.stop()
    void finalizeFatalTeardown(error)
  }

  async function finalizeFatalTeardown(error: ProtocolError | SupervisorError): Promise<void> {
    // teardown(true) kills+reaps the child and calls inbound.return(), which ends
    // the pump loop. We do NOT await pumpTask here: when this runs from inside the
    // pump the await would deadlock; inbound.return() settles it regardless.
    await teardown(true)
    deps.onFatal?.(error)
  }
```

**4e. Request senders** (new):

```ts
  async function sendRequest(kind: string, body: ControlEnvelope["body"]): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    if (phase !== "ready" || child === null) {
      return new SupervisorError({ code: "TRANSPORT_ERROR", reason: `${kind} requires a ready session (was "${phase}")` })
    }
    // Reject before send when the table is full (§8), so no envelope is written.
    if (requestTable.size() >= REQUEST_TABLE_CAPACITY) {
      return new SupervisorError({ code: "TOO_MANY_REQUESTS", reason: `request table full (${REQUEST_TABLE_CAPACITY})` })
    }
    const requestId = nextRequestId()
    const promise = requestTable.register(requestId, kind)
    const envelope: ControlEnvelope = {
      protocolVersion: 1,
      kind,
      sessionId: identity.sessionId,
      nonce: identity.nonce,
      messageId: nextMessageId(),
      requestId,
      body,
    }
    const bytes = encodeControlEnvelope(envelope)
    if (bytes instanceof ProtocolError) {
      requestTable.supersede(requestId, `${kind} encode failed [${bytes.code}]`)
      return bytes
    }
    const sent = await writeFramed(child, bytes)
    if (sent instanceof SupervisorError) {
      requestTable.supersede(requestId, `${kind} write failed [${sent.code}]`)
      return sent
    }
    return promise
  }

  const resize = (size: Size) => sendRequest("resize", { size: { w: size.w, h: size.h } })
  const setMode = (mode: InteractionMode) => sendRequest("set-mode", { interactionMode: mode })
  const ping = () => sendRequest("ping", {})
```

**4f. Re-route `stop()`.** Replace the graceful body so it no longer calls `awaitShutdownAck` (delete that function) and instead registers the shutdown in the request table, races a dedicated 1 s deadline, and awaits `pumpTask`:

```ts
  async function stop(): Promise<StopOutcome> {
    if (phase === "stopped") {
      return { phase: "stopped", forced: false, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: "already stopped" }
    }
    if (child === null || phase !== "ready") {
      const fromPhase = phase
      await teardown(true) // teardown() now closes the broker + clears the table + stops the watchdog
      await pumpTask
      phase = "stopped"
      return { phase: "stopped", forced: true, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, reason: `forced stop from phase ${fromPhase}` }
    }
    phase = "stopping"
    const activeChild = child

    // Graceful: register the shutdown so the pump can route its ack, send it, then
    // await the ack under a dedicated 1 s deadline (§9). The pump remains the sole
    // reader; stop() never pulls inbound.
    const shutdownRequestId = nextRequestId()
    const ackPromise = requestTable.register(shutdownRequestId, "shutdown")
    const shutdown: ControlEnvelope = {
      protocolVersion: 1, kind: "shutdown", sessionId: identity.sessionId, nonce: identity.nonce,
      messageId: nextMessageId(), requestId: shutdownRequestId, body: {},
    }
    const bytes = encodeControlEnvelope(shutdown)
    const forcing = await (async (): Promise<null | { reason: string }> => {
      if (bytes instanceof ProtocolError) {
        console.warn("host-supervisor: shutdown encode failed, forcing:", bytes.message)
        requestTable.supersede(shutdownRequestId, "shutdown encode failed")
        return { reason: `forced: shutdown encode failed [${bytes.code}]` }
      }
      const sent = await writeFramed(activeChild, bytes)
      if (sent instanceof SupervisorError) {
        console.warn("host-supervisor: shutdown write failed, forcing:", sent.message)
        requestTable.supersede(shutdownRequestId, "shutdown write failed")
        return { reason: `forced: shutdown write failed [${sent.code}]` }
      }
      const ack = await raceShutdownAck(ackPromise)
      if (ack instanceof Error) {
        const code = ack instanceof SupervisorError || ack instanceof ProtocolError ? ack.code : "UNKNOWN"
        console.warn("host-supervisor: no shutdown-ack, forcing:", ack.message)
        return { reason: `forced: no shutdown-ack [${code}]` }
      }
      activeChild.stdin.end()
      return null
    })()

    // teardown() reaps (kill iff forced) + closes the broker + clears the table +
    // stops the watchdog + drains stderr + returns inbound. The ack was already
    // routed by the pump (or timed out via raceShutdownAck), so clearing here is safe.
    await teardown(forcing !== null)
    await pumpTask
    phase = "stopped"
    return {
      phase: "stopped",
      forced: forcing !== null,
      exitCode: activeChild.exitCode,
      signalCode: activeChild.signalCode,
      reason: forcing?.reason ?? "graceful shutdown",
    }
  }

  // The §9 1 s shutdown-ack deadline as a dedicated timer racing the request table's
  // pump-routed ack. On timeout the table entry is left for clear() to settle.
  async function raceShutdownAck(ackPromise: Promise<ControlEnvelope | ProtocolError | SupervisorError>): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    let settleTimeout!: (error: SupervisorError) => void
    const timeout = new Promise<SupervisorError>((resolve) => { settleTimeout = resolve })
    const timer = deps.clock.setTimer(SHUTDOWN_ACK_TIMEOUT_MS, () =>
      settleTimeout(new SupervisorError({ code: "SHUTDOWN_TIMEOUT", reason: "no shutdown-ack within 1s" })),
    )
    const winner = await Promise.race([ackPromise, timeout])
    timer.cancel()
    return winner
  }
```

**4g. Modify `teardown()`** so it closes the 2D-2 components on EVERY exit path — including the pre-`ready` `failWith` path, so a facade consumer parked on `frames` never hangs after a startup failure (review finding: the broker was previously closed only on the post-`ready` path):

```ts
  async function teardown(kill: boolean): Promise<void> {
    broker.close()        // ends the frame iterator on every exit path (§10.1, brief invariant 5)
    watchdog.stop()       // idempotent; no-op if never started (pre-ready)
    requestTable.clear()  // settles stragglers; no-op if empty (a post-ready fatal already cleared with the specific error)
    if (child !== null) await reapChild(child, kill)
    stderrDrain?.stop()
    if (stderrDrain !== null) await stderrDrain.settled
    await inbound?.return?.(undefined)
  }
```

**4h. Delete** the now-unused `awaitShutdownAck` function (its identity-echo and event-routing responsibilities moved into the pump). Keep `nextInbound`, `awaitReady`, `mapHostError`, `checkEnvelopeIdentity`, `checkFrameIdentity`, `reapChild`, `failWith` — all still used by the pre-`ready` `start()` path. Handshake/mount/negotiation failures return via `failWith`, which calls `teardown(true)` and now closes the broker. The **spawn-failure early return is the one pre-`ready` path that returns WITHOUT `failWith`** (there is no child to reap yet) — add `broker.close()` to it so `frames` also ends on `SPAWN_FAILED`:

```ts
    const spawned = deps.spawn(deps.command)
    if (spawned instanceof SupervisorError) {
      broker.close() // end the frame iterator; there is no child/inbound/drain to reap yet
      phase = "failed"
      return spawned
    }
```

**4i. Return the grown handle:**

```ts
  return {
    identity,
    get phase() {
      return phase
    },
    start,
    stop,
    frames: broker.frames,
    resize,
    setMode,
    ping,
  }
```

- [ ] **Step 5: Run the session tests to verify they pass**

Run: `bun test src/host/supervisor/model/session.test.ts`
Expected: PASS — the four 2D-1 lifecycle tests AND the four new 2D-2 pump tests.

- [ ] **Step 6: Run the full gate + hang check**

Run: `bun test && bun x tsc --noEmit`
Expected: whole suite green (including `integration.test.ts` real-spawn), tsc exit 0, and `bun test` returns to the shell (no hang — the pump must not keep the process alive after `stop()`/fatal teardown).

- [ ] **Step 7: Commit**

```bash
git add src/host/supervisor/model/session.ts src/host/supervisor/model/session.test.ts src/host/supervisor/types.ts
git commit -m "feat(host-2d2): single-reader post-ready pump + stop-via-request-table refactor"
```

---

### Task 5: `PreviewSession` facade

Wires a `HostSession` + broker frames + request senders into the UI-facing subset (§3.2). Small, mostly delegation.

**Files:**
- Create: `src/host/supervisor/model/preview-session.ts`
- Create: `src/host/supervisor/model/preview-session.test.ts`
- Modify: `src/host/supervisor/types.ts` (add `PreviewSession` interface)
- Modify: `src/host/supervisor/index.ts` (re-export)

**Interfaces:**
- Consumes: `createHostSession`; `HostSessionSpec`, `HostSessionDeps`; `PreviewFrame`, `PreviewIdentity`, `Size`, `InteractionMode`.
- Produces:
  - `interface PreviewSession { readonly identity: PreviewIdentity; readonly mode: "preview" | "historical"; readonly interactionMode: InteractionMode; readonly frames: AsyncIterable<PreviewFrame>; resize(size: Size): void; setMode(mode: InteractionMode): void; retry(): void; close(): Promise<void> }`
  - `function createPreviewSession(spec: HostSessionSpec, deps: HostSessionDeps): PreviewSession`

- [ ] **Step 1: Write the failing facade tests**

Create `src/host/supervisor/model/preview-session.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { PROTOCOL_HARD_LIMITS } from "../../protocol"
import type { ProtocolError, RuntimeDeclarationBundleV1 } from "../../protocol"
import type { HostSessionSpec } from "../../types"
import type { HostSessionDeps } from "../types"
import { SupervisorError } from "./errors"
import { createManualClock } from "./clock"
import { createScriptedChild } from "./scripted-child"
import type { ScriptedChild } from "./scripted-child"
import { livePreviewChild } from "./preview-test-host"
import { createPreviewSession } from "./preview-session"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime", currentKitApiVersion: 1, supportedKitApiVersions: [1], publicCapabilityIds: [],
}
const spec: HostSessionSpec = {
  mode: "preview", interactionMode: "static", pageSlug: "dash", sourcePath: "/scratch/page.tsx",
  sourceHash: "a".repeat(64), kitApiVersion: 1, size: { w: 80, h: 24 }, theme: "dark-default", capabilities: { colorDepth: 24 },
}

// livePreviewChild is imported at the top from ./preview-test-host (a shared test
// double created in T5 Step 3, also consumed by session.test.ts).

function deps(child: ScriptedChild, clock = createManualClock()): HostSessionDeps {
  return { spawn: () => child, command: { cmd: ["_host", "--stdio"] }, clock, runtimeDeclaration, offeredLimits: PROTOCOL_HARD_LIMITS }
}

describe("createPreviewSession facade (2D-2)", () => {
  test("identity omits the nonce and mode is the host mode", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration)
    const session = createPreviewSession(spec, deps(child))
    // frames start once ready; give the internal start() a tick.
    const iterator = session.frames[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.frameSeq).toBe("1")
    expect(session.identity).not.toHaveProperty("nonce")
    expect(session.identity.sessionId.length).toBeGreaterThan(0)
    expect(session.mode).toBe("preview")
    await session.close()
  })

  test("setMode changes interactionMode only on an accepted matching response (§7)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration)
    const session = createPreviewSession(spec, deps(child))
    await session.frames[Symbol.asyncIterator]().next() // ensure ready
    expect(session.interactionMode).toBe("static")
    session.setMode("interactive")
    // The child echoes interactionMode:"interactive"; wait for the accepted response to land.
    for (let i = 0; i < 2_000 && session.interactionMode !== "interactive"; i += 1) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(session.interactionMode).toBe("interactive")
    await session.close()
  })

  test("a rejected/mismatched set-mode response preserves the prior interactionMode (§7)", async () => {
    // A child that answers set-mode with a NON-matching interactionMode.
    const child = livePreviewChild(spec, runtimeDeclaration, { setModeEcho: "static" })
    const session = createPreviewSession(spec, deps(child))
    await session.frames[Symbol.asyncIterator]().next()
    session.setMode("interactive")
    await new Promise((r) => setTimeout(r, 20))
    expect(session.interactionMode).toBe("static") // unchanged — response did not match the request
    await session.close()
  })

  test("close() stops the session and ends the frame iterator (§10.1)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration)
    const session = createPreviewSession(spec, deps(child))
    const iterator = session.frames[Symbol.asyncIterator]()
    await iterator.next() // consume the first frame
    await session.close()
    const after = await iterator.next()
    expect(after.done).toBe(true)
  })

  test("retry() is a no-op stub in 2D-2 (real restart lands in 2D-3)", async () => {
    const child = livePreviewChild(spec, runtimeDeclaration)
    const session = createPreviewSession(spec, deps(child))
    await session.frames[Symbol.asyncIterator]().next()
    expect(() => session.retry()).not.toThrow()
    await session.close()
  })

  test("interactionMode is sourced from the accepted ready response, not the requested spec (§6.6/§7)", async () => {
    // Request "interactive", but livePreviewChild's ready echoes the effective "static".
    // The facade must report the ACCEPTED "static" — proving the value comes from the
    // response, not the spec (a spec-seeded value would wrongly stay "interactive").
    const interactiveSpec: HostSessionSpec = { ...spec, interactionMode: "interactive" }
    const child = livePreviewChild(interactiveSpec, runtimeDeclaration)
    const session = createPreviewSession(interactiveSpec, deps(child))
    await session.frames[Symbol.asyncIterator]().next() // ready has landed
    expect(session.interactionMode).toBe("static")
    await session.close()
  })

  test("a pre-ready startup failure ends the frames iterator instead of hanging (§10.1, brief invariant 5)", async () => {
    // spawn returns a typed failure → start() fails before ready. teardown / the
    // spawn-failure broker.close must end the iterator so a consumer parked on frames
    // gets done:true, and the error is surfaced via onFatal (never swallowed).
    const fatals: (SupervisorError | ProtocolError)[] = []
    const failing: HostSessionDeps = {
      spawn: () => new SupervisorError({ code: "SPAWN_FAILED", reason: "boom" }),
      command: { cmd: ["_host", "--stdio"] },
      clock: createManualClock(),
      runtimeDeclaration,
      offeredLimits: PROTOCOL_HARD_LIMITS,
      onFatal: (e) => fatals.push(e),
    }
    const session = createPreviewSession(spec, failing)
    const done = await session.frames[Symbol.asyncIterator]().next()
    expect(done.done).toBe(true) // iterator ended, did not hang
    for (let i = 0; i < 2_000 && fatals.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(fatals[0] instanceof SupervisorError && fatals[0].code).toBe("SPAWN_FAILED")
  })
})
```

> **Refactor note (do this in T5 Step 1):** move the `livePreviewChild` helper introduced in T4's `session.test.ts` into the shared, non-`.test` helper module `src/host/supervisor/model/preview-test-host.ts` (source in Step 3 — parameterized by `spec` + `runtimeDeclaration`, plus an options bag `{ setModeEcho?: InteractionMode }`), and import it from both `session.test.ts` and `preview-session.test.ts`. It is a test double (like `scripted-child.ts`) and must NOT be re-exported from `index.ts`. **When you delete the inline copy from `session.test.ts` you MUST (a) add `import { livePreviewChild } from "./preview-test-host"` to its top import block and (b) update every `livePreviewChild()` call site there to `livePreviewChild(spec, runtimeDeclaration)` — otherwise tsc fails with TS2554 "Expected 2 arguments, but got 0".** `InteractionMode` in the helper is imported from `../../types`, not `../../protocol` (which does not export it).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/host/supervisor/model/preview-session.test.ts`
Expected: FAIL — `createPreviewSession` / `preview-test-host` not found.

- [ ] **Step 3: Implement the facade + shared test host**

Create `src/host/supervisor/model/preview-session.ts`:

```ts
import type { HostSessionSpec, InteractionMode, PreviewFrame, PreviewIdentity, Size } from "../../types"
import type { HostSessionDeps, PreviewSession } from "../types"
import { createHostSession } from "./session"

/**
 * The UI-facing `PreviewSession` facade subset (host-supervision §3.2). It owns a
 * HostSession (which owns the broker + request table + watchdog) and exposes only
 * what the 2C child supports today: a stable identity without the nonce, the
 * capacity-1 frame stream, and typed `resize`/`setMode` adapters over the session's
 * correlated request senders. `setMode` follows §7: the effective interaction mode
 * changes ONLY on an accepted response echoing the requested mode. `retry` is a
 * 2D-2 stub; real restart lands in 2D-3. Deferred facade methods (forwardInput,
 * setTheme, setCapabilities, geometry query, tweaks) are intentionally absent.
 */
export function createPreviewSession(spec: HostSessionSpec, deps: HostSessionDeps): PreviewSession {
  const session = createHostSession(spec, deps)
  const mode: "preview" | "historical" = spec.mode === "historical" ? "historical" : "preview"
  let interactionMode: InteractionMode = spec.interactionMode

  // Kick off the incarnation. The pump publishes frames to the broker as they arrive.
  // On success the facade adopts the ACCEPTED ready response's effective interactionMode
  // (§6.6/§7 — response-driven, not the requested spec value; the host may downgrade it).
  // On failure the frames iterator is already ended by teardown (broker.close), and the
  // error is surfaced via onFatal — or logged if no sink is injected (never swallowed).
  void session.start().then((outcome) => {
    if (outcome instanceof Error) {
      if (deps.onFatal) deps.onFatal(outcome)
      else console.warn("preview-session: startup failed:", outcome.message)
      return
    }
    const echoed = outcome.ready.body.interactionMode
    if (echoed === "static" || echoed === "interactive") interactionMode = echoed
  })

  return {
    get identity(): PreviewIdentity {
      const { nonce: _nonce, ...rest } = session.identity
      return rest
    },
    get mode() {
      return mode
    },
    get interactionMode() {
      return interactionMode
    },
    frames: session.frames,
    resize(size: Size) {
      // Fire-and-forget dispatch; the response is diagnostic-only in 2D-2 (no queue/
      // backpressure surface until 2D-3) but a dropped error is LOGGED, never swallowed.
      void session.resize(size).then((result) => {
        if (result instanceof Error) console.warn("preview-session: resize failed:", result.message)
      })
    },
    setMode(next: InteractionMode) {
      void session.setMode(next).then((result) => {
        if (result instanceof Error) {
          console.warn("preview-session: set-mode failed:", result.message) // rejection/timeout/stale preserves the prior mode (§7)
          return
        }
        if (result.body.interactionMode === next) interactionMode = next
      })
    },
    retry() {
      // 2D-2 stub — the restart budget/circuit that acts on this lands in 2D-3.
    },
    async close() {
      await session.stop()
    },
  }
}
```

Create the shared test host `src/host/supervisor/model/preview-test-host.ts` (extracted from T4; a test double, never re-exported from `index.ts`):

```ts
// TEST DOUBLE — a responding fake 2C host that reaches ready and answers post-ready
// requests (ping/resize/set-mode/shutdown), emits frames + heartbeats on demand.
// Shared by session.test.ts and preview-session.test.ts. Not part of the public
// supervisor surface.
import { PROTOCOL_HARD_LIMITS, ProtocolError } from "../../protocol"
import type { ControlEnvelope, FrameEnvelope, HostHelloV1, RuntimeDeclarationBundleV1 } from "../../protocol"
// InteractionMode lives in host/types and is NOT re-exported from ../../protocol.
import type { HostSessionSpec, InteractionMode } from "../../types"
import { createScriptedChild, frameControl, frameFrame, frameHostHello } from "./scripted-child"
import type { ScriptedChild } from "./scripted-child"
import { readInbound } from "./transport"

export interface LivePreviewChild extends ScriptedChild {
  emitFrame(seq: string): void
  emitHeartbeat(): void
}

export function livePreviewChild(
  spec: HostSessionSpec,
  runtimeDeclaration: RuntimeDeclarationBundleV1,
  options?: { setModeEcho?: InteractionMode },
): LivePreviewChild {
  const child = createScriptedChild() as LivePreviewChild
  let id: { sessionId: string; nonce: string } | null = null
  let messageId = 1n
  const nextId = () => {
    const value = messageId.toString()
    messageId += 1n
    return value
  }
  const send = (env: ControlEnvelope) => {
    const framed = frameControl(env)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  child.onWrite = (bytes) => void decode(bytes)
  async function decode(bytes: Uint8Array) {
    const carrier = createScriptedChild()
    carrier.emit(bytes)
    carrier.endStdout()
    for await (const message of readInbound(carrier)) {
      if (message instanceof Error) return
      if (message.messageClass !== "control") return
      const raw = JSON.parse(new TextDecoder().decode(message.payload)) as ControlEnvelope & { kind: string }
      if (raw.kind === "client.hello" && id === null) {
        id = { sessionId: raw.sessionId, nonce: raw.nonce }
        const hostHello: HostHelloV1 = {
          framingVersion: 1, kind: "host.hello", sessionId: id.sessionId, nonce: id.nonce,
          selectedFramingVersion: 1, selectedProtocolVersion: 1, runtimeDeclaration, limits: PROTOCOL_HARD_LIMITS,
        }
        const framed = frameHostHello(hostHello)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (id === null) return
      if (raw.kind === "mount") {
        send({ protocolVersion: 1, kind: "ready", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: { w: 80, h: 24 }, interactionMode: "static" } })
        const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: "1", width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
        const framed = frameFrame(frame)
        if (!(framed instanceof ProtocolError)) child.emit(framed)
        return
      }
      if (raw.kind === "ping") return send({ protocolVersion: 1, kind: "pong", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: {} })
      if (raw.kind === "resize") return send({ protocolVersion: 1, kind: "resize", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { size: raw.body.size } })
      if (raw.kind === "set-mode") {
        const echo = options?.setModeEcho ?? (raw.body.interactionMode as InteractionMode)
        return send({ protocolVersion: 1, kind: "set-mode", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { interactionMode: echo } })
      }
      if (raw.kind === "shutdown") {
        send({ protocolVersion: 1, kind: "shutdown-ack", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), responseTo: raw.requestId, body: { ok: true } })
        child.simulateExit({ code: 0 })
        return
      }
    }
  }
  child.emitFrame = (seq) => {
    if (id === null) return
    const frame: FrameEnvelope = { protocolVersion: 1, kind: "frame", sessionId: id.sessionId, nonce: id.nonce, sourceHash: spec.sourceHash, frameSeq: seq, width: 80, height: 24, rows: Array.from({ length: 24 }, () => []) }
    const framed = frameFrame(frame)
    if (!(framed instanceof ProtocolError)) child.emit(framed)
  }
  child.emitHeartbeat = () => {
    if (id === null) return
    send({ protocolVersion: 1, kind: "heartbeat", sessionId: id.sessionId, nonce: id.nonce, messageId: nextId(), body: {} })
  }
  return child
}
```

Update `session.test.ts` (T4) to import `livePreviewChild` from `./preview-test-host` instead of the inline copy, and delete the inline copy there.

Add to `src/host/supervisor/types.ts`:

```ts
import type { InteractionMode, PreviewFrame, PreviewIdentity, Size } from "../types"
// ...

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
```

Re-export from `src/host/supervisor/index.ts`:

```ts
export { createPreviewSession } from "./model/preview-session"
export type { PreviewSession } from "./types"
```

- [ ] **Step 4: Run the facade tests to verify they pass**

Run: `bun test src/host/supervisor/model/preview-session.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate + hang check**

Run: `bun test && bun x tsc --noEmit`
Expected: whole suite green, tsc exit 0, no hang.

- [ ] **Step 6: Commit**

```bash
git add src/host/supervisor/model/preview-session.ts src/host/supervisor/model/preview-session.test.ts src/host/supervisor/model/preview-test-host.ts src/host/supervisor/model/session.test.ts src/host/supervisor/types.ts src/host/supervisor/index.ts
git commit -m "feat(host-2d2): PreviewSession facade subset (frames, resize, setMode, retry-stub, close)"
```

---

### Task 6: whole-slice gate, ledger, arch-doc note, adversarial review

Closes 2D-2. No new product code beyond fixes the review confirms.

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- (Conditional) any file the adversarial review confirms a defect in — fixed TDD.

- [ ] **Step 1: Full gate + hang check**

Run: `bun test && bun x tsc --noEmit`
Expected: whole suite green (211 baseline + ~30 new 2D-2 tests), tsc exit 0, `bun test` returns to the shell. Record exact pass/fail counts.

- [ ] **Step 2: Reatom audit (per CLAUDE.md mandatory `/reatom`)**

Run the five read-only Reatom domain auditors (`/reatom` → reatom-audit) over the 2D-2 diff. Expected: 0 findings — host/supervisor is deliberately non-Reatom (closure-based driver + codecs), consistent with 2C/2D-1. Record the 0/0/0 result in the ledger.

- [ ] **Step 3: Architecture-doc check (architecture-update skill)**

Run the architecture-audit skill against the changed source. Per the standing 2C decision (ledger lines 98–103): host/ `Source anchors` in `docs/architecture/` are NOT yet migrated to real `src/host` paths and stay deferred until host/ is complete (2D-3/2D-4) or the phase-8 sweep. 2D-2 does not complete host/, so **no anchor migration** — confirm no *new* drift was introduced and note the continued deferral in the ledger. (CLAUDE.md's architecture-update mandate triggers only for behavior/structure *covered by an existing doc*; host supervision is not yet anchored, so there is nothing to update beyond the ledger.)

- [ ] **Step 4: Adversarial whole-slice review (ultracode, as 2D-1 did)**

Run the ultracode multi-lens review over the whole 2D-2 slice. Suggested lenses (each finding verified by ≥3 refute-by-default skeptics, majority ≥2/3 to confirm):
- **errore-conformance** — unions vs throws, `instanceof Error` early returns, no silent swallow, `.catch`/`try` only at boundaries.
- **protocol/spec-conformance** — §8 capacity-1 + coalesce count; §10.1 stale guard completeness (session+nonce+sourceHash+monotonic seq); §9 timeout durations (2 s/5 s/1 s) and the "frames don't reset heartbeat" rule; §7 one-terminal-outcome + set-mode-only-on-accepted.
- **pump correctness & teardown-nohang** — single-reader invariant (no second `inbound.next()` pull ever), fatal path idempotency (pump vs watchdog vs stop racing), no leaked pump task / timers / drains on every exit path, `bun test` returns.
- **request-table/broker edge cases** — 65th reject before send; late/duplicate resolve; supersede after resolve; broker `close()` while pending; BigInt seq comparison.
- **facade subset** — no deferred method half-built; identity nonce omission; `interactionMode` gating; `close()` closes the iterator.
- **test-integrity** — do the tests actually distinguish success from regression (no assertions that pass on the failure path); is the T4 de-risking probe's disposal clean.

Apply every CONFIRMED finding TDD (failing test → fix → green gate → one commit each), exactly as 2D-1 did. Re-run the gate after fixes.

- [ ] **Step 5: Write the ledger entry**

Append a `## Plan 2D-2 — broker / PreviewSession — COMPLETE` section to `.superpowers/sdd/progress.md` in the 2D-1 style: plan path, commit range, gate counts (pass/fail, tsc, no-hang), per-task one-liners (T1–T5) with any deviations, the Reatom 0/0/0 result, the arch-doc deferral note, the ratified decisions from the "Decisions & deviations" section (esp. the `QUERY_TIMEOUT`-reuse-for-unresponsive call and whether the review upheld it), and the adversarial review outcome (candidates → confirmed → fixes). Set `NEXT:` to 2D-3 (restart budget/backoff/circuit + backpressure/mailbox + `HostSupervisor`).

- [ ] **Step 6: Commit the ledger**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(host-2d2): ledger entry — broker/PreviewSession slice complete"
```

---

## Self-Review

**1. Spec coverage** (brief §4 spec-row → task map, all present):

| Spec row | Task | Covered by |
|---|---|---|
| §8 broker = 1 complete frame; atomic replace; `framesCoalesced++` | T1 | coalesce-count + slow-consumer tests |
| §10.1 broker compares session, nonce, sourceHash, monotonic `frameSeq` | T1 | stale-by-{nonce,session,source} + non-monotonic tests |
| §10.1 closing/superseding closes the frame iterator | T1, T5 | `close()` ends iterator (broker) + facade `close()` test |
| §3.2 `PreviewFrame` immutable; identity sans nonce | T1, T5 | yield-without-nonce + facade identity test |
| §8 request table = 64; `TOO_MANY_REQUESTS` before send | T2, T4 | 65th-reject test + `sendRequest` size guard |
| §9 2 s → `QUERY_TIMEOUT`; late responses discarded | T2 | timeout + late-resolve tests |
| §7 replaced hover → `SUPERSEDED`; one terminal outcome | T2 | supersede test |
| §9 5 s since last heartbeat → `HEARTBEAT_TIMEOUT` even if frames arrive | T3 | 5 s-silence + noteRequestTimeout-doesn't-reset tests |
| §9 3 request timeouts in 10 s → unresponsive | T3 | 3-in-10 s escalation + window-drop tests |
| §7 set-mode correlated; mode changes only on accepted response | T4, T5 | facade accepted vs mismatched set-mode tests |
| §6/§8 the pump: one reader; frames non-blocking; controls correlated | T4 | pump frames/ping/heartbeat tests + probe |
| §3.2 facade subset | T5 | facade suite |
| §14.2 slow-consumer bounded broker | T1 | 240-frame test |
| §14.2 stale old-nonce frame rejected at the broker | T1 | stale-by-nonce test |
| §14.4/§14.5 delayed set-mode completes once; mode only on accepted | T5 | mismatched-echo test |
| §14.4 heartbeat-timeout kills | T4 | HEARTBEAT_TIMEOUT-to-failed test |

**2. Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — every step carries real code or an exact command + expected output. The one intentional throwaway (T4 pump probe) is explicitly created, run, and deleted, not committed.

**3. Type consistency:** the names used across tasks match — `FrameBroker.publish`/`frames`/`framesCoalesced`/`close`; `RequestTable.register`/`resolve`/`supersede`/`clear`/`size` + `REQUEST_TABLE_CAPACITY`; `HeartbeatWatchdog.start`/`feedHeartbeat`/`noteRequestTimeout`/`stop`; `HostSession` grown with `frames`/`resize`/`setMode`/`ping`; `HostSessionDeps` grown with `onFatal`/`createBroker`/`createRequestTable`/`createWatchdog`; `PreviewSession` with `identity`/`mode`/`interactionMode`/`frames`/`resize`/`setMode`/`retry`/`close`. `createPreviewSession(spec, deps)` and `createHostSession(spec, deps)` share the `HostSessionDeps` shape.

**4. Known open items handed to the adversarial plan-review** (the "Decisions & deviations" section): the `QUERY_TIMEOUT`-reuse for the unresponsive escalation vs. a new `UNRESPONSIVE` code; `onFatal` seam vs. a `PreviewLifecycleEvent` union; the facade's added `interactionMode` getter; factory-seam injection; the `REQUEST_TABLE_CAPACITY` pre-send guard. The T4 teardown choreography (fatal-path idempotency across pump/watchdog/stop) is de-risked by the T4 Step 0 probe and re-verified by the review's pump/teardown lens.

---

## Execution Handoff

Per the 2D-2 sequence recorded in the design brief §7 and the ledger, the immediate next step after this plan is the **ultracode adversarial plan-review** (a heavy multi-agent step) — NOT direct execution. After the review's confirmed findings are applied, the order is: T4 de-risking probe → subagent-driven execution (T1–T5) → T6 whole-slice review.

When execution does begin, use **superpowers:subagent-driven-development** (recommended): a fresh subagent per task with two-stage review between tasks; the controller runs `bun test && bun x tsc --noEmit` between tasks and keeps the ledger.

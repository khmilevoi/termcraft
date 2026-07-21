# `agent/` Module Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `agent/` into four shared sub-modules and four vendor sub-modules, moving the whole §6.5 run/health policy out of `agent/claude/` and collapsing four duplications — without changing behavior.

**Architecture:** The run lifecycle inverts. A shared `startAgentRun` owns the event queue, terminal latch, exit-confirmation ladder and cancel ladder; the vendor supplies only a `RunDriver` over its own stream. Health splits the same way: a shared `runHealthProbe` owns the deadline, the process-tree close and the "never report `ready` on ambiguity" classification, while the vendor keeps message classification. The shared tier imports no vendor SDK type in either direction.

**Tech Stack:** TypeScript 7, Bun (test runner + runtime), `errore` (errors as values), `@anthropic-ai/claude-agent-sdk` 0.3.212, `infrastructure/process` (Windows Job Object trees).

**Design spec:** `docs/superpowers/specs/2026-07-21-agent-module-restructure-design.md`

## Global Constraints

- **Factories use the `create` prefix, never `make`.** Rename stragglers in files you touch: `makeConfinementPolicy` → `createConfinementPolicy`, `makeSpawnAndAdopt` → `createSpawnAndAdopt`.
- **Cross-module imports use absolute aliases**, never a relative path that climbs out of the current module or `entities/` submodule. Inside one sub-module, `./` and `../` are fine. Aliases live in `tsconfig.json` `compilerOptions.paths`.
- **A new top-level or sub-module folder needs an alias only if imported by bare name.** `agent/run`, `agent/confinement`, `agent/session`, `agent/health` are reached as `agent/run/...` etc., which the existing `agent/*` wildcard already covers. Do not add new `paths` entries.
- **The shared tier (`agent/run`, `agent/confinement`, `agent/session`, `agent/health`) must not import `@anthropic-ai/claude-agent-sdk`.** Not even `import type`. This is the invariant that makes a second backend possible.
- **Every module folder is `model/` + `types.ts` + `index.ts`.** Omit `types.ts` only when the sub-module declares no shared types; never put loose `.ts` files at a module root.
- **Errors are values.** `instanceof Error` with a one-line early return. Anything not propagated gets a `console.warn`. Raw `try/catch` only at a vendor async-generator boundary; `errore.try` for sync boundaries.
- **Behavior is preserved.** Exactly one approved delta, in Task 5: `BashOutput` and `KillShell` gain `op: "run"` instead of falling through to `"other"`.
- **No assertion may be deleted.** Tests move to the file owning their subject. If an assertion becomes inexpressible after a split, the split is wrong — stop and report rather than weaken the test.
- **Baseline to hold:** `bun test src/agent` → 143 pass, 0 fail, 278 `expect()` calls. `bunx tsc --noEmit` → clean. The `expect()` count must never decrease.
- **Comments:** do NOT clean up comments in Tasks 1-6. Move them with their code, verbatim, even when they reference `finding [N]`. Task 7 does the whole comment pass at once.

---

## File Structure

**Shared tier (created across Tasks 1-4, 6):**

| File | Responsibility |
|---|---|
| `src/agent/run/types.ts` | `NaturalOutcome`, `RunSink`, `RunDriver`, `RunDeps` |
| `src/agent/run/index.ts` | Shared run tier entry point |
| `src/agent/run/model/event-queue.ts` | Single-reader async queue bridging driver → `AgentRun.events` |
| `src/agent/run/model/exit-confirm.ts` | `confirmExit`, `escalateAndConfirm`, `ProcessTree` boundary guards |
| `src/agent/run/model/engine.ts` | `startAgentRun`: latch, outcome, sink, cancel ladder |
| `src/agent/run/model/degraded-run.ts` | `createDegradedRun` for a run that never got a process tree |
| `src/agent/run/model/unconfirmed-exit-latch.ts` | Backend-level §6.5 lockout after an unconfirmed exit |
| `src/agent/confinement/types.ts` | `ConfinementTables`, `PermissionResultLike` |
| `src/agent/confinement/model/policy.ts` | `createConfinementPolicy` — the deny-by-default rule |
| `src/agent/confinement/model/path-containment.ts` | `isInsideStaging` |
| `src/agent/session/model/session-scope.ts` | `deriveSessionScope` |
| `src/agent/session/model/prompt.ts` | `buildPrompt` |
| `src/agent/health/types.ts` | `HealthProbeDeps`, `HealthProbeReader` |
| `src/agent/health/model/deadline.ts` | `withProbeDeadline`, `defaultWait`, `ProbeDeadlineAbortError` |
| `src/agent/health/model/probe.ts` | `runHealthProbe` — deadline + tree close + ambiguity classification |
| `src/agent/health/model/errors.ts` | `AgentHealthProbeError` |

**Vendor tier (created across Tasks 2, 4-6):**

| File | Responsibility |
|---|---|
| `src/agent/claude/run/model/drive-stream.ts` | `createClaudeDriver` — the `RunDriver` over `ClaudeQuery` |
| `src/agent/claude/run/model/normalize.ts` | `SDKMessage` → `AgentEvent` |
| `src/agent/claude/tools/model/vocabulary.ts` | `CLAUDE_TOOLS` + every derived table |
| `src/agent/claude/tools/model/tool-op.ts` | `mapToolUse` |
| `src/agent/claude/query/model/query-fn.ts` | `createRealQueryFn` |
| `src/agent/claude/query/model/query-options.ts` | `buildQueryOptions` |
| `src/agent/claude/query/model/session-options.ts` | `planToSessionOptions` |
| `src/agent/claude/query/model/can-use-tool.ts` | `createCanUseTool` — policy → SDK `CanUseTool` |
| `src/agent/claude/query/model/spawn-adopt.ts` | `createSpawnAndAdopt` |
| `src/agent/claude/backend/model/backend.ts` | `createClaudeBackend` |
| `src/agent/claude/backend/model/backend-id.ts` | `CLAUDE_BACKEND_ID` |
| `src/agent/claude/backend/model/capabilities.ts` | `claudeCapabilities` |
| `src/agent/claude/backend/model/probe.ts` | `buildProbeOptions`, `classifyMessage`, `readUntilClassified` |
| `src/agent/claude/backend/model/errors.ts` | `ClaudeSdkError` |

**Deleted by the end:** `src/agent/model/` entirely, and every file under `src/agent/claude/model/`.

---

### Task 1: Shared `run/` primitives — event queue and exit confirmation

Pure moves out of `agent-run.ts`, plus one new composition (`escalateAndConfirm`) that collapses a duplicated block. `agent-run.ts` keeps working by importing them.

**Files:**
- Create: `src/agent/run/model/event-queue.ts`
- Create: `src/agent/run/model/exit-confirm.ts`
- Create: `src/agent/run/index.ts`
- Create: `src/agent/run/model/exit-confirm.test.ts`
- Modify: `src/agent/claude/model/agent-run.ts` (delete the moved code, import it instead)
- Modify: `src/agent/claude/model/agent-run.test.ts` (update imports only)

**Interfaces:**
- Consumes: `ProcessTree`, `ProcessTreeError` from `infrastructure/process`; `FencedEvent` from `agent/types`; `AgentEvent`, `TurnFence` from `entities/turn`.
- Produces:
  - `createEventQueue(fence: TurnFence): EventQueue` where `EventQueue = { push(event: AgentEvent): void; finish(): void; readonly iterable: AsyncIterable<FencedEvent> }`
  - `POLL_INTERVAL_MS: number` (value `100`)
  - `confirmExit(tree: ProcessTree, wait: (ms: number) => Promise<void>, budgetMs: number): Promise<boolean>`
  - `escalateAndConfirm(tree: ProcessTree, wait: (ms: number) => Promise<void>, budgetMs: number): Promise<boolean>`

- [ ] **Step 1: Create `src/agent/run/model/event-queue.ts`**

Move `createEventQueue` and the `EventQueue` interface out of `src/agent/claude/model/agent-run.ts:131-226` **verbatim** — including every comment. Change only the imports and the parameter type:

```ts
import type { AgentEvent, TurnFence } from "entities/turn"
import type { FencedEvent } from "agent/types"

/** A minimal single-reader async queue bridging a run's driver to `AgentRun.events`. */
export interface EventQueue {
  push(event: AgentEvent): void
  finish(): void
  readonly iterable: AsyncIterable<FencedEvent>
}

// ...doc comment moved verbatim from agent-run.ts...
export function createEventQueue(fence: TurnFence): EventQueue {
  // body moved verbatim
}
```

The old signature took `fence: AgentTask["fence"]`; use `TurnFence` directly — same type, no `AgentTask` dependency.

- [ ] **Step 2: Create `src/agent/run/model/exit-confirm.ts`**

Move `describeThrown`, `safeActiveProcesses`, `safeTerminate`, `safeWait`, `POLL_INTERVAL_MS` and `pollUntilZero` out of `agent-run.ts:35-129` verbatim. Rename `pollUntilZero` → `confirmExit` and export it. Change the `console.warn` prefixes from `agent/agent-run:` to `agent/run:`. Then add the new composition:

```ts
/**
 * §6.5 escalation: send tree-wide termination, then re-poll within a fresh
 * budget. Both the cancel ladder's rung 4 and the natural-completion
 * escalation are this exact sequence — it lives here once so the two can
 * never drift apart.
 */
export async function escalateAndConfirm(
  processTree: ProcessTree,
  wait: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const terminateResult = safeTerminate(processTree)
  if (terminateResult instanceof ProcessTreeError) {
    console.warn("agent/run: processTree.terminate() failed while escalating:", terminateResult.message)
  }
  return confirmExit(processTree, wait, budgetMs)
}
```

`describeThrown` stays local to this file and is NOT exported — see the spec's Follow-ups; it is duplicated on purpose.

- [ ] **Step 3: Create `src/agent/run/index.ts`**

```ts
export { createEventQueue } from "./model/event-queue"
export type { EventQueue } from "./model/event-queue"
export { confirmExit, escalateAndConfirm, POLL_INTERVAL_MS } from "./model/exit-confirm"
```

- [ ] **Step 4: Write the failing test for `escalateAndConfirm`**

Create `src/agent/run/model/exit-confirm.test.ts`. Use the existing fake process tree helper — find it with `rtk grep createFakeProcessTree src/` and import it the same way `agent-run.test.ts` does.

```ts
import { describe, expect, test } from "bun:test"
import { confirmExit, escalateAndConfirm, POLL_INTERVAL_MS } from "./exit-confirm"

describe("escalateAndConfirm", () => {
  test("terminates the tree, then reports a confirmed exit when the re-poll drains", async () => {
    const calls: string[] = []
    let active = 2
    const tree = {
      adopt: () => null,
      activeProcesses: () => {
        calls.push("poll")
        return active
      },
      terminate: () => {
        calls.push("terminate")
        active = 0
        return null
      },
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS * 3)
    expect(confirmed).toBe(true)
    expect(calls[0]).toBe("terminate")
  })

  test("reports an unconfirmed exit when the tree never drains after terminate()", async () => {
    const tree = {
      adopt: () => null,
      activeProcesses: () => 3,
      terminate: () => null,
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS * 2)
    expect(confirmed).toBe(false)
  })

  test("a terminate() that throws is logged and still followed by the re-poll", async () => {
    let polls = 0
    const tree = {
      adopt: () => null,
      activeProcesses: () => {
        polls += 1
        return 0
      },
      terminate: () => {
        throw new Error("boom")
      },
      ownershipConfirmed: () => true,
      close: () => {},
      noteAdoptionOutcome: () => {},
    }
    const confirmed = await escalateAndConfirm(tree as never, async () => {}, POLL_INTERVAL_MS)
    expect(confirmed).toBe(true)
    expect(polls).toBeGreaterThan(0)
  })
})
```

If the repo's `createFakeProcessTree` helper already covers these shapes, use it instead of the inline literals above — prefer the shared helper.

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test src/agent/run/model/exit-confirm.test.ts`
Expected: FAIL — `Cannot find module './exit-confirm'` if Step 2 was skipped, otherwise PASS immediately (the code is a move, so red-green here is thin; the real gate is Step 7).

- [ ] **Step 6: Rewire `agent-run.ts` to the new modules**

In `src/agent/claude/model/agent-run.ts`: delete the moved code and import instead.

```ts
import { createEventQueue } from "agent/run"
import { confirmExit, escalateAndConfirm } from "agent/run"
```

Replace the body of `resolveAfterExitConfirm` with the composition:

```ts
async function resolveAfterExitConfirm(outcome: AgentRunOutcome): Promise<void> {
  if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
    resolveOutcome(outcome)
    return
  }
  console.warn(
    `agent/agent-run: exit not confirmed after natural ${outcome.kind}, escalating to terminate() before reporting an outcome`,
  )
  const reconfirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
  resolveOutcome(reconfirmed ? outcome : { kind: "unconfirmed-exit" })
}
```

And the tail of `runCancelLadder`:

```ts
  const postTerminateConfirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
  resolveOutcome(postTerminateConfirmed ? { kind: "cancelled", exitConfirmed: true } : { kind: "unconfirmed-exit" })
```

Keep the long rung-3 divergence doc comment on `runCancelLadder` exactly where it is.

`agent-run.ts` re-exports `POLL_INTERVAL_MS` today; keep that re-export so its test keeps compiling: `export { POLL_INTERVAL_MS } from "agent/run"`.

- [ ] **Step 7: Run the full agent suite**

Run: `bun test src/agent`
Expected: `143 pass, 0 fail` and **at least** 278 `expect()` calls (the new tests add more).

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
rtk git add src/agent && rtk git commit -m "refactor(agent): extract the shared run event queue and exit-confirm ladder"
```

---

### Task 2: The run engine and the Claude stream driver

The main surgery. `agent-run.ts` disappears; the vendor keeps ~70 lines.

**Files:**
- Create: `src/agent/run/types.ts`
- Create: `src/agent/run/model/engine.ts`
- Create: `src/agent/run/model/engine.test.ts`
- Create: `src/agent/claude/run/model/drive-stream.ts`
- Create: `src/agent/claude/run/model/drive-stream.test.ts`
- Create: `src/agent/claude/run/index.ts`
- Move: `src/agent/claude/model/normalize.ts` → `src/agent/claude/run/model/normalize.ts` (and its test)
- Modify: `src/agent/run/index.ts`
- Modify: `src/agent/claude/model/claude-backend.ts` (call `startAgentRun` + `createClaudeDriver`)
- Delete: `src/agent/claude/model/agent-run.ts` and `src/agent/claude/model/agent-run.test.ts` (contents redistributed)

**Interfaces:**
- Consumes: `createEventQueue`, `confirmExit`, `escalateAndConfirm` from Task 1; `normalizeMessage`, `deriveUsage` from `normalize.ts`; `ClaudeQueryFn`, `ClaudeQuery` from `agent/claude/types`; `ClaudeSdkError` from `agent/claude/model/errors` (moves in Task 6).
- Produces:
  - `startAgentRun(fence: TurnFence, driver: RunDriver, deps: RunDeps): { run: AgentRun; cancel: () => Promise<void> }`
  - `createClaudeDriver(params: { queryFn: ClaudeQueryFn; prompt: string; options: Options }): RunDriver`
  - the `RunSink` / `RunDriver` / `NaturalOutcome` / `RunDeps` types below

- [ ] **Step 1: Create `src/agent/run/types.ts`**

```ts
import type { AgentEvent, TokenUsage, TurnFence } from "entities/turn"
import type { ProcessTree } from "infrastructure/process"

/**
 * The terminal outcome a vendor stream can produce on its own. `cancelled` and
 * `unconfirmed-exit` are the engine's to decide — a driver never names them.
 */
export type NaturalOutcome =
  | {
      readonly kind: "completed"
      readonly finalText: string
      readonly usage: TokenUsage | null
      readonly sessionId: string
    }
  | { readonly kind: "backend-error"; readonly message: string; readonly sessionId: string | null }

/** The engine-owned surface one run's driver writes to. */
export interface RunSink {
  /**
   * True once this run has a terminal owner — i.e. `cancel()` won the race.
   * The driver must stop reading and return; nothing it does after this is
   * observable (turn-durability §6.4's late-event drop).
   */
  isTerminal(): boolean
  /**
   * Emit one normalized event. Never blocks and never depends on a reader, so
   * `outcome` settles even when nobody iterates `AgentRun.events`.
   */
  emit(event: AgentEvent): void
  /**
   * Claim the natural terminal outcome together with this run's last events.
   * The engine latches, emits `finalEvents`, closes the stream, and only then
   * runs exit confirmation — passing the events here rather than emitting them
   * separately is what makes that ordering structural instead of a convention.
   * If the latch is already taken, both the outcome and the events are dropped.
   */
  complete(outcome: NaturalOutcome, finalEvents?: readonly AgentEvent[]): void
}

/**
 * One vendor's stream reader. A driver owns its own vendor error vocabulary and
 * is expected to convert its boundary throws into `complete({kind:"backend-error"})`;
 * the engine's own catch is a backstop, not the primary path.
 */
export type RunDriver = (sink: RunSink) => Promise<void>

/** Deps for {@link startAgentRun}. Carries no vendor type — by design. */
export interface RunDeps {
  readonly processTree: ProcessTree
  readonly abortController: AbortController
  /** Injectable delay for the §6.5 waits; production = `(ms) => Bun.sleep(ms)`. */
  readonly wait: (ms: number) => Promise<void>
  readonly confirmTimeoutMs?: number
}

export type { TurnFence }
```

- [ ] **Step 2: Create `src/agent/run/model/engine.ts`**

```ts
import * as errore from "errore"
import type { AgentRun, AgentRunOutcome } from "agent/types"
import type { TurnFence } from "entities/turn"
import type { NaturalOutcome, RunDeps, RunDriver, RunSink } from "../types"
import { createEventQueue } from "./event-queue"
import { confirmExit, escalateAndConfirm } from "./exit-confirm"

/**
 * Cancellation reason handed to `abortController.abort()` (§6.5 rung 1).
 * Extends `errore.AbortError` so `errore.isAbortError` detects it even after it
 * is wrapped in a `.catch()` cause chain elsewhere.
 */
class TurnAbortError extends errore.createTaggedError({
  name: "TurnAbortError",
  message: "turn cancelled",
  extends: errore.AbortError,
}) {}

/** Default §6.5 exit-confirmation budget when the caller does not override it. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 5000

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Drive one fenced attempt. The driver streams through an internal queue
 * decoupled from it, and runs fire-and-forget: `outcome` settles whether or not
 * anything ever reads `run.events`.
 *
 * A single `terminalKind` latch decides who resolves `outcome`: whichever of
 * the driver's natural completion or `cancel()` flips it first wins, and the
 * loser's remaining work is discarded. `cancel()` is memoized so concurrent
 * calls share one ladder run.
 *
 * Non-Reatom: the latch, the queue and the cancel memo are explicit
 * closure-owned state scoped to one run's lifetime, matching `agent/`'s
 * non-Reatom adapter status (CLAUDE.md).
 */
export function startAgentRun(
  fence: TurnFence,
  driver: RunDriver,
  deps: RunDeps,
): { run: AgentRun; cancel: () => Promise<void> } {
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS
  const queue = createEventQueue(fence)

  let terminalKind: "natural" | "cancelled" | null = null
  /** Compare-and-swap the termination latch; returns true only for the winner. */
  function latch(kind: "natural" | "cancelled"): boolean {
    if (terminalKind !== null) return false
    terminalKind = kind
    return true
  }

  let resolveOutcome: (outcome: AgentRunOutcome) => void = () => {}
  const outcomePromise = new Promise<AgentRunOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  /**
   * turn-durability §6.4/§6.5: a natural completion must CONFIRM the whole
   * process tree exited before the kernel may retire the fence and snapshot the
   * candidate workspace. If the first poll cannot confirm, escalate exactly like
   * the cancel ladder before falling back to `unconfirmed-exit`.
   */
  async function resolveWithExitConfirm(outcome: AgentRunOutcome): Promise<void> {
    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      resolveOutcome(outcome)
      return
    }
    console.warn(
      `agent/run: exit not confirmed after natural ${outcome.kind}, escalating to terminate() before reporting an outcome`,
    )
    const reconfirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(reconfirmed ? outcome : { kind: "unconfirmed-exit" })
  }

  let claimed: NaturalOutcome | null = null

  const sink: RunSink = {
    isTerminal: () => terminalKind !== null,
    emit: (event) => queue.push(event),
    complete: (outcome, finalEvents) => {
      if (!latch("natural")) return // cancel already won (late-event drop, §6.4)
      for (const event of finalEvents ?? []) queue.push(event)
      queue.finish()
      claimed = outcome
    },
  }

  async function runDriver(): Promise<void> {
    try {
      await driver(sink)
    } catch (cause) {
      // Backstop only: a driver is expected to convert its own boundary throws.
      // Swallowed and logged (errore rule 21) so a leak cannot leave `outcome`
      // pending forever.
      console.warn("agent/run: driver threw past its own boundary:", describeThrown(cause))
      if (latch("natural")) {
        const message = `agent run failed: ${describeThrown(cause)}`
        queue.push({ kind: "error", message })
        queue.finish()
        claimed = { kind: "backend-error", message, sessionId: null }
      }
    }

    if (claimed === null && latch("natural")) {
      // The driver returned without claiming an outcome and without cancel
      // winning — report it as a failure so `outcome` still settles.
      const message = "agent run ended without a terminal outcome"
      queue.push({ kind: "error", message })
      queue.finish()
      claimed = { kind: "backend-error", message, sessionId: null }
    }

    if (claimed !== null) await resolveWithExitConfirm(claimed)
  }

  // Fire-and-forget: `outcome` must settle even if `events` is never read.
  void runDriver()

  let cancelPromise: Promise<void> | null = null

  /**
   * turn-durability §6.5's cancel ladder is five rungs: (1) stop non-terminal
   * events + graceful backend cancel, (2) wait <=5s, (3) send graceful TREE
   * termination and wait <=5s, (4) hard-kill and wait <=5s, (5) only then may
   * the caller snapshot/quarantine/reuse.
   *
   * This implements rungs 1, 2 and 4 and stops there; rung 5's disposition is
   * the caller's decision, made from this function's outcome. The budget is
   * therefore 10s (2 rungs of <=5s), not the spec's 15s.
   *
   * NOTE FOR TASK 7: the full rung-3 divergence analysis currently lives on
   * `runCancelLadder` in `agent/claude/model/agent-run.ts`. Move it here
   * verbatim — CLAUDE.md requires a documented divergence to stay in a code
   * comment, and this is now its only home.
   */
  async function runCancelLadder(): Promise<void> {
    deps.abortController.abort(new TurnAbortError({})) // rung 1

    if (!latch("cancelled")) {
      // A natural outcome already won, or a previous cancel() already ran —
      // never fight the winner, just wait for whatever it resolved.
      await outcomePromise
      return
    }
    queue.finish() // cancellation carries no AgentEvent — just end the stream.

    if (await confirmExit(deps.processTree, deps.wait, confirmTimeoutMs)) {
      // rung 2
      resolveOutcome({ kind: "cancelled", exitConfirmed: true })
      return
    }

    // rung 4 (hard kill) — rung 3 is the documented gap above.
    const confirmed = await escalateAndConfirm(deps.processTree, deps.wait, confirmTimeoutMs)
    resolveOutcome(confirmed ? { kind: "cancelled", exitConfirmed: true } : { kind: "unconfirmed-exit" })
  }

  function cancel(): Promise<void> {
    if (cancelPromise === null) cancelPromise = runCancelLadder()
    return cancelPromise
  }

  const run: AgentRun = { fence, events: queue.iterable, outcome: outcomePromise }
  return { run, cancel }
}
```

- [ ] **Step 3: Extend `src/agent/run/index.ts`**

```ts
export { createEventQueue } from "./model/event-queue"
export type { EventQueue } from "./model/event-queue"
export { confirmExit, escalateAndConfirm, POLL_INTERVAL_MS } from "./model/exit-confirm"
export { startAgentRun } from "./model/engine"
export type { NaturalOutcome, RunDeps, RunDriver, RunSink } from "./types"
```

- [ ] **Step 4: Move `normalize.ts` into the vendor run sub-module**

```bash
mkdir -p src/agent/claude/run/model
rtk git mv src/agent/claude/model/normalize.ts src/agent/claude/run/model/normalize.ts
rtk git mv src/agent/claude/model/normalize.test.ts src/agent/claude/run/model/normalize.test.ts
```

`normalize.ts` imports `./tool-op`; leave that import pointing at the old location for now (`agent/claude/model/tool-op` via a relative `../../model/tool-op`) — **no**: use the alias instead, `import { mapToolUse } from "agent/claude/model/tool-op"`. Task 5 repoints it to `agent/claude/tools`.

- [ ] **Step 5: Create `src/agent/claude/run/model/drive-stream.ts`**

```ts
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent } from "entities/turn"
import type { RunDriver } from "agent/run"
import type { ClaudeQueryFn } from "agent/claude/types"
import { ClaudeSdkError } from "agent/claude/model/errors"
import { deriveUsage, normalizeMessage } from "./normalize"

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined
}

export interface ClaudeDriverParams {
  readonly queryFn: ClaudeQueryFn
  readonly prompt: string
  readonly options: Options
}

/**
 * The Claude `RunDriver`: read the SDK stream, normalize each message into
 * `AgentEvent`s, and claim a natural outcome on the first `result` message.
 *
 * The engine owns the latch, the queue and the exit-confirmation ladder — this
 * function owns only the vendor vocabulary: `SDKMessage` shapes, `session_id`
 * tracking, and `ClaudeSdkError`.
 */
export function createClaudeDriver(params: ClaudeDriverParams): RunDriver {
  return async (sink) => {
    let lastSessionId: string | null = null

    const failStream = (reason: string, cause?: unknown): void => {
      const sdkError = new ClaudeSdkError({ code: "STREAM_FAILED", reason, cause: asError(cause) })
      const events: AgentEvent[] = [{ kind: "error", message: sdkError.message }]
      sink.complete({ kind: "backend-error", message: sdkError.message, sessionId: lastSessionId }, events)
    }

    try {
      const query = params.queryFn({ prompt: params.prompt, options: params.options })
      for await (const msg of query) {
        if (sink.isTerminal()) return // cancel already won the race

        if ("session_id" in msg && typeof msg.session_id === "string") lastSessionId = msg.session_id

        if (msg.type !== "result") {
          for (const event of normalizeMessage(msg)) sink.emit(event)
          continue
        }

        const events = normalizeMessage(msg)
        if (msg.subtype === "success") {
          sink.complete(
            { kind: "completed", finalText: msg.result, usage: deriveUsage(msg), sessionId: msg.session_id },
            events,
          )
          return
        }
        const errorEvent = events[0]
        const message = errorEvent?.kind === "error" ? errorEvent.message : `unexpected result ${msg.subtype}`
        sink.complete({ kind: "backend-error", message, sessionId: msg.session_id }, events)
        return
      }

      // The generator ended cleanly without ever yielding a `result` message.
      failStream("stream ended without a result message")
    } catch (cause) {
      // Boundary: `query` is an injected/vendor async generator we do not
      // control — a raw try/catch here (not `errore.try`, which is for sync
      // boundaries) is the errore-sanctioned way to convert an external throw
      // into a value at the lowest call-stack level.
      failStream(describeThrown(cause), cause)
    }
  }
}
```

- [ ] **Step 6: Create `src/agent/claude/run/index.ts`**

```ts
export { createClaudeDriver } from "./model/drive-stream"
export type { ClaudeDriverParams } from "./model/drive-stream"
export { deriveUsage, normalizeMessage } from "./model/normalize"
```

- [ ] **Step 7: Write the engine contract tests**

Create `src/agent/run/model/engine.test.ts`. These are the new `RunSink`-contract tests the spec requires. Note they use a **fake driver** — no SDK anywhere.

```ts
import { describe, expect, test } from "bun:test"
import { startAgentRun } from "./engine"
import type { RunSink } from "../types"

const fence = { turnId: "t1", attempt: 1 } as never // match the shape used in agent-run.test.ts

function drainedTree() {
  return {
    adopt: () => null,
    activeProcesses: () => 0,
    terminate: () => null,
    ownershipConfirmed: () => true,
    close: () => {},
    noteAdoptionOutcome: () => {},
  } as never
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    processTree: drainedTree(),
    abortController: new AbortController(),
    wait: async () => {},
    confirmTimeoutMs: 10,
    ...overrides,
  } as never
}

describe("startAgentRun sink contract", () => {
  test("complete() emits finalEvents, closes the stream, and resolves the outcome", async () => {
    const { run } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        sink.emit({ kind: "reasoning", text: "thinking" })
        sink.complete({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" }, [
          { kind: "final", text: "done" },
        ])
      },
      deps(),
    )

    const seen = []
    for await (const e of run.events) seen.push(e.event)

    expect(seen).toEqual([
      { kind: "reasoning", text: "thinking" },
      { kind: "final", text: "done" },
    ])
    expect(await run.outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
  })

  test("complete() after cancel won drops both the outcome and its finalEvents", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { run, cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        await gate
        sink.complete({ kind: "completed", finalText: "late", usage: null, sessionId: "s1" }, [
          { kind: "final", text: "late" },
        ])
      },
      deps(),
    )

    await cancel()
    release()

    expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })

    const seen = []
    for await (const e of run.events) seen.push(e.event)
    expect(seen).toEqual([])
  })

  test("isTerminal() reports true to the driver once cancel has won", async () => {
    let observed: boolean | null = null
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { cancel } = startAgentRun(
      fence,
      async (sink: RunSink) => {
        await gate
        observed = sink.isTerminal()
      },
      deps(),
    )

    await cancel()
    release()
    await Bun.sleep(0)
    expect(observed).toBe(true)
  })

  test("a driver that throws past its own boundary becomes a backend-error, not a pending outcome", async () => {
    const { run } = startAgentRun(
      fence,
      async () => {
        throw new Error("driver exploded")
      },
      deps(),
    )

    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
    if (outcome.kind === "backend-error") expect(outcome.message).toContain("driver exploded")
  })

  test("a driver that returns without completing still settles the outcome", async () => {
    const { run } = startAgentRun(fence, async () => {}, deps())
    const outcome = await run.outcome
    expect(outcome.kind).toBe("backend-error")
  })
})
```

Fix `fence` to whatever real shape `agent-run.test.ts` uses — read that file first and copy its fence literal rather than inventing one.

- [ ] **Step 8: Write the driver tests**

Create `src/agent/claude/run/model/drive-stream.test.ts`. Port every SDK-message-mapping assertion out of `agent-run.test.ts` here, driving `createClaudeDriver` with a **fake sink**:

```ts
import { describe, expect, test } from "bun:test"
import { createClaudeDriver } from "./drive-stream"
import type { NaturalOutcome } from "agent/run"
import type { AgentEvent } from "entities/turn"

function fakeSink() {
  const emitted: AgentEvent[] = []
  const completions: { outcome: NaturalOutcome; finalEvents: readonly AgentEvent[] }[] = []
  let terminal = false
  return {
    emitted,
    completions,
    setTerminal: () => {
      terminal = true
    },
    sink: {
      isTerminal: () => terminal,
      emit: (e: AgentEvent) => emitted.push(e),
      complete: (outcome: NaturalOutcome, finalEvents: readonly AgentEvent[] = []) =>
        completions.push({ outcome, finalEvents }),
    },
  }
}

function scriptedQuery(messages: readonly unknown[]) {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    interrupt: async () => {},
  })
}

describe("createClaudeDriver", () => {
  test("claims a completed outcome on a success result", async () => {
    const { sink, completions } = fakeSink()
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([
        { type: "result", subtype: "success", result: "hello", session_id: "s9", usage: {}, modelUsage: {} },
      ]) as never,
      prompt: "p",
      options: {} as never,
    })
    await driver(sink as never)
    expect(completions).toHaveLength(1)
    expect(completions[0]?.outcome).toMatchObject({ kind: "completed", finalText: "hello", sessionId: "s9" })
  })

  test("reports a stream that ends without a result as a backend-error", async () => {
    const { sink, completions } = fakeSink()
    const driver = createClaudeDriver({ queryFn: scriptedQuery([]) as never, prompt: "p", options: {} as never })
    await driver(sink as never)
    expect(completions[0]?.outcome.kind).toBe("backend-error")
    expect(completions[0]?.finalEvents[0]).toMatchObject({ kind: "error" })
  })

  test("converts a throwing stream into a backend-error carrying the last session id", async () => {
    const { sink, completions } = fakeSink()
    const queryFn = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "s3" }
        throw new Error("stream died")
      },
      interrupt: async () => {},
    })
    const driver = createClaudeDriver({ queryFn: queryFn as never, prompt: "p", options: {} as never })
    await driver(sink as never)
    expect(completions[0]?.outcome).toMatchObject({ kind: "backend-error", sessionId: "s3" })
    if (completions[0]?.outcome.kind === "backend-error") {
      expect(completions[0].outcome.message).toContain("stream died")
    }
  })

  test("stops reading as soon as the sink reports terminal", async () => {
    const { sink, emitted, setTerminal } = fakeSink()
    setTerminal()
    const driver = createClaudeDriver({
      queryFn: scriptedQuery([
        { type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "hi" }] } },
      ]) as never,
      prompt: "p",
      options: {} as never,
    })
    await driver(sink as never)
    expect(emitted).toEqual([])
  })
})
```

- [ ] **Step 9: Redistribute the rest of `agent-run.test.ts`**

Read `src/agent/claude/model/agent-run.test.ts` (567 lines) and move **every** assertion to its new owner:

| Assertion subject | Destination |
|---|---|
| queue buffering, single-reader, `return()`/abandon, second-iterator rejection | `src/agent/run/model/event-queue.test.ts` (create) |
| `POLL_INTERVAL_MS` spacing, poll budget, `ownershipConfirmed` gating, `ProcessTreeError` tolerance | `src/agent/run/model/exit-confirm.test.ts` (extend Task 1's file) |
| cancel ladder rungs, latch races, `unconfirmed-exit`, cancel memoization | `src/agent/run/model/engine.test.ts` |
| SDK message mapping, `session_id` tracking, `ClaudeSdkError` text | `src/agent/claude/run/model/drive-stream.test.ts` |

Then delete `agent-run.test.ts` and `agent-run.ts`.

- [ ] **Step 10: Rewire `claude-backend.ts`**

Replace the `startClaudeRun` call:

```ts
import { startAgentRun } from "agent/run"
import { createClaudeDriver } from "agent/claude/run"

// ...inside startTurn, after buildQueryOptions:
const driver = createClaudeDriver({ queryFn: deps.queryFn, prompt: buildPrompt(task), options })
const { run, cancel } = startAgentRun(task.fence, driver, {
  processTree: tree,
  abortController,
  wait: deps.wait,
  confirmTimeoutMs: deps.confirmTimeoutMs,
})
```

- [ ] **Step 11: Run the suite**

Run: `bun test src/agent`
Expected: `0 fail`, pass count **>= 143**, `expect()` count **>= 278**.

Run: `bunx tsc --noEmit`
Expected: no output.

If the pass count dropped, an assertion was lost in Step 9 — find it and restore it before continuing.

- [ ] **Step 12: Commit**

```bash
rtk git add src/agent && rtk git commit -m "refactor(agent): invert the run loop into a shared engine plus a Claude stream driver"
```

---

### Task 3: Shared `confinement/` and `session/` sub-modules

Pure folder moves plus the two `make*` → `create*` renames. Doing this before the vendor tasks means Tasks 4-6 land on final import paths.

**Files:**
- Move: `src/agent/model/confinement.ts` → `src/agent/confinement/model/policy.ts` (+ test)
- Move: `src/agent/model/path-containment.ts` → `src/agent/confinement/model/path-containment.ts` (+ test)
- Move: `src/agent/model/session-scope.ts` → `src/agent/session/model/session-scope.ts` (+ test)
- Move: `buildPrompt` out of `src/agent/claude/model/session-plan.ts` → `src/agent/session/model/prompt.ts`
- Create: `src/agent/confinement/types.ts`, `src/agent/confinement/index.ts`
- Create: `src/agent/session/index.ts`
- Modify: every importer

**Interfaces:**
- Produces: `createConfinementPolicy(stagingRoot, tables, options?)`, `isInsideStaging`, `ConfinementTables`, `PermissionResultLike`, `deriveSessionScope(backendId, input)`, `buildPrompt(task)`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/agent/confinement/model src/agent/session/model
rtk git mv src/agent/model/confinement.ts src/agent/confinement/model/policy.ts
rtk git mv src/agent/model/confinement.test.ts src/agent/confinement/model/policy.test.ts
rtk git mv src/agent/model/path-containment.ts src/agent/confinement/model/path-containment.ts
rtk git mv src/agent/model/path-containment.test.ts src/agent/confinement/model/path-containment.test.ts
rtk git mv src/agent/model/session-scope.ts src/agent/session/model/session-scope.ts
rtk git mv src/agent/model/session-scope.test.ts src/agent/session/model/session-scope.test.ts
```

- [ ] **Step 2: Split the types out of `policy.ts`**

Create `src/agent/confinement/types.ts` holding `PermissionResultLike` and `ConfinementTables`, moved verbatim (with their doc comments) from `policy.ts`. `policy.ts` then imports them: `import type { ConfinementTables, PermissionResultLike } from "../types"`.

- [ ] **Step 3: Rename the factory**

In `policy.ts`, rename `makeConfinementPolicy` → `createConfinementPolicy`. Update its doc comment's self-reference if it names itself.

- [ ] **Step 4: Create `src/agent/confinement/index.ts`**

```ts
export { createConfinementPolicy } from "./model/policy"
export { isInsideStaging } from "./model/path-containment"
export type { ConfinementTables, PermissionResultLike } from "./types"
```

- [ ] **Step 5: Split `session-plan.ts`**

Create `src/agent/session/model/prompt.ts` with `buildPrompt` moved verbatim from `src/agent/claude/model/session-plan.ts:9-24`, importing `AgentTask` from `agent/types`. Leave `planToSessionOptions` in `session-plan.ts` — it returns SDK-shaped options and stays vendor (Task 6 moves it).

Create `src/agent/session/index.ts`:

```ts
export { deriveSessionScope } from "./model/session-scope"
export { buildPrompt } from "./model/prompt"
```

`session-scope.ts` imports `SessionScopeInput` from `"../types"` today, which after the move points at a non-existent `agent/session/types.ts`. Repoint it to the port: `import type { SessionScopeInput } from "agent/types"`.

- [ ] **Step 6: Move `buildPrompt`'s tests**

`src/agent/claude/model/session-plan.test.ts` covers both functions. Split it: `buildPrompt` assertions → `src/agent/session/model/prompt.test.ts`; `planToSessionOptions` assertions stay.

- [ ] **Step 7: Repoint every importer**

Run `rtk grep "agent/model/" src/` and update each hit:
- `agent/model/confinement` → `agent/confinement`
- `agent/model/path-containment` → `agent/confinement`
- `agent/model/session-scope` → `agent/session`
- `makeConfinementPolicy(` → `createConfinementPolicy(`

`src/agent/model/errors.ts` stays put until Task 4.

- [ ] **Step 8: Run the suite**

Run: `bun test src/agent` → `0 fail`, count not decreasing.
Run: `bunx tsc --noEmit` → no output.

- [ ] **Step 9: Commit**

```bash
rtk git add src/agent && rtk git commit -m "refactor(agent): move confinement and session into shared sub-modules"
```

---

### Task 4: Shared `health/` and the Claude probe

**Files:**
- Create: `src/agent/health/types.ts`, `src/agent/health/index.ts`
- Create: `src/agent/health/model/deadline.ts`, `src/agent/health/model/probe.ts`
- Create: `src/agent/health/model/probe.test.ts`
- Move: `src/agent/model/errors.ts` → `src/agent/health/model/errors.ts` (+ test); delete `src/agent/model/`
- Create: `src/agent/claude/backend/model/probe.ts` (+ test)
- Modify: `src/agent/claude/model/health.ts` (shrinks, then is deleted in Task 6)

**Interfaces:**
- Consumes: `AgentInfo` from `agent/types`; `ProcessTree` from `infrastructure/process`; `createConfinementPolicy` from `agent/confinement` (Task 3).
- Produces:
  - `runHealthProbe(backendId: string, read: HealthProbeReader, deps: HealthProbeDeps): Promise<AgentInfo>`
  - `withProbeDeadline<T>(pending: Promise<T>, deps: {...}): Promise<T | ProbeDeadlineAbortError>`
  - `readUntilClassified(queryFn: ClaudeQueryFn, deps: HealthProbeDeps): Promise<AgentInfo | null>`

- [ ] **Step 1: Create `src/agent/health/types.ts`**

```ts
import type { ProcessTree } from "infrastructure/process"
import type { AgentInfo } from "agent/types"

/**
 * Reads a vendor probe stream until one of its messages classifies the health
 * state. Resolves `null` when the stream closed cleanly with no verdict. MAY
 * reject — {@link runHealthProbe} converts that into a value.
 */
export type HealthProbeReader = () => Promise<AgentInfo | null>

export interface HealthProbeDeps {
  readonly abortController: AbortController
  /**
   * The owned process tree the probe CLI is adopted into, or `null` when the
   * caller's `ProcessTreeFactory` could not produce one. Required — not
   * optional — so a caller can never silently forget to wire it; `null` is the
   * one deliberate, explicit opt-out.
   */
  readonly processTree: ProcessTree | null
  /** Injectable delay for the probe deadline; defaults to an `unref`'d timer. */
  readonly wait?: (ms: number) => Promise<void>
  /** Probe read budget; defaults to 20_000 ms. */
  readonly deadlineMs?: number
}
```

- [ ] **Step 2: Create `src/agent/health/model/deadline.ts`**

Move `ProbeDeadlineAbortError`, `DEFAULT_PROBE_DEADLINE_MS`, `defaultWait` and `withProbeDeadline` out of `src/agent/claude/model/health.ts:51-56, 96-105, 223-253` verbatim, with two changes: export all four, and make `withProbeDeadline` generic.

```ts
export async function withProbeDeadline<T>(
  pending: Promise<T>,
  deps: Pick<HealthProbeDeps, "abortController" | "wait" | "deadlineMs">,
): Promise<T | ProbeDeadlineAbortError> {
  // body moved verbatim; `winner` is now `T | ProbeDeadlineAbortError`
}
```

Change the `console.warn` prefix from `agent/health:` to `agent/health:` (unchanged — the shared tier keeps this label).

- [ ] **Step 3: Create `src/agent/health/model/probe.ts`**

```ts
import * as errore from "errore"
import type { AgentInfo } from "agent/types"
import type { HealthProbeDeps, HealthProbeReader } from "../types"
import { withProbeDeadline } from "./deadline"
import { AgentHealthProbeError } from "./errors"

function describeThrown(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function inconclusive(backendId: string): AgentInfo {
  return { backendId, health: { status: "not-logged-in" }, account: null }
}

/**
 * Run one backend's health probe under a bounded deadline and classify its
 * result. The vendor supplies `read`, which knows its own message vocabulary;
 * everything here is backend-agnostic policy:
 *
 *  - the deadline, its abort, and suppression of the abandoned read's late
 *    rejection (deadline.ts);
 *  - closing the adopted process tree once the probe settles, on EVERY path —
 *    this one call site sits after every branch, so a new early return cannot
 *    skip it. Arms kill-on-close for a probe CLI that ignored the abort;
 *  - the classification of an inconclusive probe. NEVER report `ready` on
 *    ambiguity: a false-ready would let a real, paid turn start against a
 *    broken backend, so an abort with no verdict, a stream failure, and a clean
 *    close with no verdict all classify the same as an explicit auth failure.
 */
export async function runHealthProbe(
  backendId: string,
  read: HealthProbeReader,
  deps: HealthProbeDeps,
): Promise<AgentInfo> {
  const result = await withProbeDeadline(read(), deps).catch(
    (e) => new AgentHealthProbeError({ reason: describeThrown(e), cause: e }),
  )

  deps.processTree?.close()

  if (errore.isAbortError(result)) {
    console.warn("agent/health: probe aborted without a confirmed verdict:", result.message)
    return inconclusive(backendId)
  }

  if (result instanceof Error) {
    // Swallowed (the probe never throws) — logged so a broken CLI/spawn path
    // stays visible, per errore's "log what you don't propagate".
    console.warn("agent/health: probe stream failed:", result.message)
    const notInstalled = /ENOENT|not found|spawn/i.test(result.message)
    return { backendId, health: { status: notInstalled ? "not-installed" : "not-logged-in" }, account: null }
  }

  if (result !== null) return result

  // The stream closed cleanly without ever classifying. The CLI ran without
  // throwing, so this is not "not-installed"; nothing confirmed a working
  // session either, so it must not be "ready".
  return inconclusive(backendId)
}
```

- [ ] **Step 4: Move the shared error and delete `agent/model/`**

```bash
mkdir -p src/agent/health/model
rtk git mv src/agent/model/errors.ts src/agent/health/model/errors.ts
rtk git mv src/agent/model/errors.test.ts src/agent/health/model/errors.test.ts
rmdir src/agent/model
```

Create `src/agent/health/index.ts`:

```ts
export { runHealthProbe } from "./model/probe"
export { withProbeDeadline, defaultWait, DEFAULT_PROBE_DEADLINE_MS, ProbeDeadlineAbortError } from "./model/deadline"
export { AgentHealthProbeError } from "./model/errors"
export type { HealthProbeDeps, HealthProbeReader } from "./types"
```

- [ ] **Step 5: Create `src/agent/claude/backend/model/probe.ts`**

Move `PROBE_CWD`, `ProbeClassifiedAbortError`, `buildProbeOptions`, `classifyMessage`, `describeThrown` and `readUntilClassified` out of `health.ts` verbatim (including all comments), then add the thin entry point:

```ts
/**
 * The Claude health probe: run a minimal, isolated "ping" query and read until
 * a message classifies the state. Everything not specific to Claude's message
 * vocabulary — the deadline, the tree close, the ambiguity classification —
 * belongs to `runHealthProbe` (agent/health).
 */
export function probeClaudeHealth(queryFn: ClaudeQueryFn, deps: HealthProbeDeps): Promise<AgentInfo> {
  return runHealthProbe(CLAUDE_BACKEND_ID, () => readUntilClassified(queryFn, deps), deps)
}
```

`buildProbeOptions` uses `createConfinementPolicy` (renamed in Task 3) and `CLAUDE_CONFINEMENT_TABLES`. Import them as `agent/confinement` and `agent/claude/model/tool-tables` — Task 5 repoints the latter.

`readUntilClassified`'s deps type changes from `ProbeHealthDeps` to `HealthProbeDeps` (same shape, imported from `agent/health`).

- [ ] **Step 6: Write `src/agent/health/model/probe.test.ts`**

The classification table, driven by a fake reader — no SDK message anywhere.

```ts
import { describe, expect, test } from "bun:test"
import { runHealthProbe } from "./probe"

const deps = { abortController: new AbortController(), processTree: null, wait: async () => {}, deadlineMs: 10 }

describe("runHealthProbe classification", () => {
  test("passes a vendor verdict through unchanged", async () => {
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null }
    expect(await runHealthProbe("x", async () => verdict, deps)).toEqual(verdict)
  })

  test("a clean close with no verdict is not-logged-in, never ready", async () => {
    const info = await runHealthProbe("x", async () => null, deps)
    expect(info.health).toEqual({ status: "not-logged-in" })
  })

  test("a spawn/ENOENT failure is not-installed", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("spawn claude ENOENT")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-installed" })
  })

  test("any other stream failure is not-logged-in", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("socket reset")
      },
      deps,
    )
    expect(info.health).toEqual({ status: "not-logged-in" })
  })

  test("closes the process tree on every path", async () => {
    let closed = 0
    const tree = { close: () => { closed += 1 } } as never
    await runHealthProbe("x", async () => null, { ...deps, processTree: tree })
    await runHealthProbe(
      "x",
      async () => {
        throw new Error("boom")
      },
      { ...deps, processTree: tree },
    )
    expect(closed).toBe(2)
  })
})
```

- [ ] **Step 7: Redistribute `health.test.ts`**

Read `src/agent/claude/model/health.test.ts` (357 lines). Assertions about `classifyMessage`, `buildProbeOptions` isolation (cwd, `settingSources`, `canUseTool`, `spawnClaudeCodeProcess`) and `readUntilClassified` move to `src/agent/claude/backend/model/probe.test.ts`. Assertions about the deadline, the tree close and the not-installed/not-logged-in classification move to the shared `probe.test.ts` / a new `deadline.test.ts`. Then reduce `health.ts` to just `claudeCapabilities` (Task 6 moves it out and deletes the file).

- [ ] **Step 8: Run the suite and commit**

Run: `bun test src/agent` → `0 fail`, counts not decreasing. `bunx tsc --noEmit` → clean.

```bash
rtk git add src/agent && rtk git commit -m "refactor(agent): split health into a shared probe harness and a Claude classifier"
```

---

### Task 5: Unified Claude tool vocabulary

**Files:**
- Create: `src/agent/claude/tools/model/vocabulary.ts`, `src/agent/claude/tools/index.ts`
- Create: `src/agent/claude/tools/model/vocabulary.test.ts`
- Move: `src/agent/claude/model/tool-op.ts` → `src/agent/claude/tools/model/tool-op.ts` (+ test)
- Delete: `src/agent/claude/model/tool-tables.ts`
- Modify: importers of `CLAUDE_CONFINEMENT_TABLES`, `mapToolUse`, and `DISALLOWED` in `query-fn.ts`

**Interfaces:**
- Produces: `CLAUDE_TOOLS`, `CLAUDE_CONFINEMENT_TABLES: ConfinementTables`, `CLAUDE_DISALLOWED_TOOLS: readonly string[]`, `PATH_FIELDS`, `TARGET_FIELDS`, `mapToolUse(name, input)`.

- [ ] **Step 1: Write the regression test FIRST**

Create `src/agent/claude/tools/model/vocabulary.test.ts` asserting the derived tables equal today's literals. This is the only thing that proves the dedup is faithful, so it must exist before the old tables are deleted.

```ts
import { describe, expect, test } from "bun:test"
import { CLAUDE_CONFINEMENT_TABLES, CLAUDE_DISALLOWED_TOOLS, PATH_FIELDS, TARGET_FIELDS } from "./vocabulary"

describe("derived tables match the pre-unification literals", () => {
  test("denied tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort()).toEqual(
      ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"].sort(),
    )
  })

  test("disallowedTools passed to the SDK equals the denied set", () => {
    expect([...CLAUDE_DISALLOWED_TOOLS].sort()).toEqual([...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort())
  })

  test("file tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.fileTools].sort()).toEqual(
      ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS"].sort(),
    )
  })

  test("optional-path tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.optionalPathTools].sort()).toEqual(["Grep", "Glob", "LS"].sort())
  })

  test("path fields keep their original order", () => {
    expect(PATH_FIELDS).toEqual(["file_path", "path", "notebook_path", "notebookPath"])
  })

  test("target fields extend path fields and never feed confinement", () => {
    expect(TARGET_FIELDS).toEqual([...PATH_FIELDS, "command", "pattern", "url"])
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).toEqual(PATH_FIELDS)
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("command")
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("url")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/agent/claude/tools`
Expected: FAIL — `Cannot find module './vocabulary'`.

- [ ] **Step 3: Create `src/agent/claude/tools/model/vocabulary.ts`**

```ts
import type { AgentToolOp } from "entities/turn"
import type { ConfinementTables } from "agent/confinement"

/**
 * One Claude Code tool. `op` and `access` are deliberately ORTHOGONAL: a denied
 * tool can still appear in a `tool_use` block before the `canUseTool` veto
 * fires, and the UI must still render it — so `Bash` carries both `op: "run"`
 * and `access: "denied"`.
 *
 * `access`:
 *  - `path-confined` — schema REQUIRES a path; a call carrying none is
 *    malformed and stays denied.
 *  - `path-optional` — schema documents `path` as optional, defaulting to cwd.
 *    The agent's cwd IS the staging root (`buildQueryOptions`), so a path-less
 *    call means "the staging root itself" and resolves there.
 *  - `denied` — refused outright regardless of arguments (master §6.1).
 */
interface ClaudeTool {
  readonly name: string
  readonly op: AgentToolOp
  readonly access: "path-confined" | "path-optional" | "denied"
}

/**
 * Verified against the installed `@anthropic-ai/claude-agent-sdk`'s
 * `sdk-tools.d.ts`. Two entries are currently INERT — this SDK build has no
 * `MultiEdit` and no `LS` tool, so `canUseTool` will never be called with those
 * names. They are kept defensively, matching their historical schemas, for an
 * older or future SDK build that reintroduces them; re-verify against the
 * schema if that happens.
 */
const CLAUDE_TOOLS: readonly ClaudeTool[] = [
  { name: "Read", op: "read", access: "path-confined" },
  { name: "Write", op: "edit", access: "path-confined" },
  { name: "Edit", op: "edit", access: "path-confined" },
  { name: "MultiEdit", op: "edit", access: "path-confined" },
  { name: "NotebookEdit", op: "edit", access: "path-confined" },
  { name: "Glob", op: "read", access: "path-optional" },
  { name: "LS", op: "read", access: "path-optional" },
  { name: "Grep", op: "search", access: "path-optional" },
  { name: "Bash", op: "run", access: "denied" },
  { name: "BashOutput", op: "run", access: "denied" },
  { name: "KillShell", op: "run", access: "denied" },
  { name: "WebFetch", op: "search", access: "denied" },
  { name: "WebSearch", op: "search", access: "denied" },
]

function namesWhere(access: ClaudeTool["access"]): string[] {
  return CLAUDE_TOOLS.filter((tool) => tool.access === access).map((tool) => tool.name)
}

/**
 * Field names, in order, that carry a tool's primary PATH argument. This is the
 * list confinement resolves a target from.
 */
export const PATH_FIELDS = ["file_path", "path", "notebook_path", "notebookPath"] as const

/**
 * Field names the UI renders as a tool's target. A superset of {@link PATH_FIELDS}
 * that additionally covers non-path targets.
 *
 * MUST NOT be fed to confinement: `command`, `pattern` and `url` are not paths,
 * and treating a Bash command string as a path would hand the containment test
 * a value it was never meant to resolve.
 */
export const TARGET_FIELDS = [...PATH_FIELDS, "command", "pattern", "url"] as const

const OPTIONAL_PATH_TOOLS = new Set(namesWhere("path-optional"))

/** Claude Code's tool vocabulary wired into the shared deny-by-default rule. */
export const CLAUDE_CONFINEMENT_TABLES: ConfinementTables = {
  fileTools: new Set([...namesWhere("path-confined"), ...namesWhere("path-optional")]),
  deniedTools: new Set(namesWhere("denied")),
  optionalPathTools: OPTIONAL_PATH_TOOLS,
  pathFields: PATH_FIELDS,
}

/** The SDK `Options.disallowedTools` list — the same set confinement denies. */
export const CLAUDE_DISALLOWED_TOOLS: readonly string[] = namesWhere("denied")

const OP_BY_TOOL = new Map(CLAUDE_TOOLS.map((tool) => [tool.name, tool.op]))

/** The UI op for one tool name; unknown names render as `other`. */
export function toolOp(name: string): AgentToolOp {
  return OP_BY_TOOL.get(name) ?? "other"
}
```

- [ ] **Step 4: Run the regression test**

Run: `bun test src/agent/claude/tools`
Expected: PASS, all six tests.

- [ ] **Step 5: Move and rewrite `tool-op.ts`**

```bash
rtk git mv src/agent/claude/model/tool-op.ts src/agent/claude/tools/model/tool-op.ts
rtk git mv src/agent/claude/model/tool-op.test.ts src/agent/claude/tools/model/tool-op.test.ts
```

Rewrite `tool-op.ts` to use the vocabulary instead of its own tables:

```ts
import type { AgentToolOp } from "entities/turn"
import { TARGET_FIELDS, toolOp } from "./vocabulary"

/** Map an SDK `tool_use` block to the UI's op + target (master §6.1). */
export function mapToolUse(name: string, input: Record<string, unknown>): { op: AgentToolOp; target: string } {
  const target = (() => {
    for (const field of TARGET_FIELDS) {
      const v = input[field]
      if (typeof v === "string") return v
    }
    return ""
  })()
  return { op: toolOp(name), target }
}
```

In `tool-op.test.ts`, update the two assertions that expect `BashOutput`/`KillShell` → `"other"` if they exist; they now expect `"run"`. **This is the plan's one approved behavior delta** — if no such assertion exists, add one asserting `mapToolUse("BashOutput", {}).op === "run"`.

- [ ] **Step 6: Create `src/agent/claude/tools/index.ts`**

```ts
export { CLAUDE_CONFINEMENT_TABLES, CLAUDE_DISALLOWED_TOOLS, PATH_FIELDS, TARGET_FIELDS, toolOp } from "./model/vocabulary"
export { mapToolUse } from "./model/tool-op"
```

- [ ] **Step 7: Repoint importers and delete `tool-tables.ts`**

Run `rtk grep "tool-tables\|CLAUDE_CONFINEMENT_TABLES\|DISALLOWED" src/`. Update each to `agent/claude/tools`. In `query-fn.ts`, delete the local `const DISALLOWED = [...]` and use `disallowedTools: [...CLAUDE_DISALLOWED_TOOLS]`. In `normalize.ts`, repoint `mapToolUse` to `agent/claude/tools`. Then `rtk git rm src/agent/claude/model/tool-tables.ts`.

- [ ] **Step 8: Run the suite and commit**

Run: `bun test src/agent` → `0 fail`. `bunx tsc --noEmit` → clean.

```bash
rtk git add src/agent && rtk git commit -m "refactor(agent): unify the Claude tool vocabulary into one table"
```

---

### Task 6: Vendor `query/` and `backend/` assembly

The last structural task. Everything left in `agent/claude/model/` moves out and the folder disappears.

**Files:**
- Create: `src/agent/run/model/degraded-run.ts`, `src/agent/run/model/unconfirmed-exit-latch.ts` (+ tests)
- Move: `query-fn.ts` → `src/agent/claude/query/model/query-fn.ts` (split into `query-fn.ts` + `query-options.ts`)
- Move: `session-plan.ts` → `src/agent/claude/query/model/session-options.ts`
- Move: `spawn-adopt.ts` → `src/agent/claude/query/model/spawn-adopt.ts`
- Create: `src/agent/claude/query/model/can-use-tool.ts`, `src/agent/claude/query/index.ts`
- Move: `claude-backend.ts` → `src/agent/claude/backend/model/backend.ts`
- Move: `backend-id.ts`, `errors.ts` → `src/agent/claude/backend/model/`
- Create: `src/agent/claude/backend/model/capabilities.ts`, `src/agent/claude/backend/index.ts`
- Delete: `src/agent/claude/model/` entirely
- Modify: `src/agent/claude/index.ts`

**Interfaces:**
- Produces: `createDegradedRun(fence, message)`, `createUnconfirmedExitLatch(backendId)`, `createCanUseTool(policy)`, `createSpawnAndAdopt(tree, label)`, `buildQueryOptions(task, deps)`, `planToSessionOptions(plan)`, `claudeCapabilities()`, `createClaudeBackend(deps)`.

- [ ] **Step 1: Create `src/agent/run/model/degraded-run.ts`**

Move `singleEventIterable` and `degradedRun` out of `claude-backend.ts:20-52` verbatim; rename the factory and take a fence instead of a task.

```ts
import type { AgentRun, AgentRunOutcome, FencedEvent } from "agent/types"
import type { TurnFence } from "entities/turn"

/** An `AsyncIterable` that yields `event` exactly once, then completes. */
function singleEventIterable(event: FencedEvent): AsyncIterable<FencedEvent> {
  // body moved verbatim
}

/**
 * A run degraded before it ever started — typically because `startTurn` could
 * not obtain an owned process tree (§6.5). Without a tree there is nothing for
 * the exit-confirmation ladder to poll and nothing for confinement to stand
 * behind, so failing the attempt outright is safer than running it unconfined.
 * Reported in the shape a real attempt uses on failure: one `error` event on
 * the fence, then a matching `backend-error` outcome.
 */
export function createDegradedRun(fence: TurnFence, message: string): AgentRun {
  const outcome: AgentRunOutcome = { kind: "backend-error", message, sessionId: null }
  return {
    fence,
    events: singleEventIterable({ fence, event: { kind: "error", message } }),
    outcome: Promise.resolve(outcome),
  }
}
```

- [ ] **Step 2: Create `src/agent/run/model/unconfirmed-exit-latch.ts`**

```ts
import type { AgentRunOutcome } from "agent/types"

export interface UnconfirmedExitLatch {
  isLatched(): boolean
  noteOutcome(outcome: AgentRunOutcome): void
}

/**
 * Sticky, per-backend-instance lockout. Set the moment any run resolves
 * `unconfirmed-exit` — turn-durability §6.5 requires a backend be locked out of
 * new turns until "a full health check proves the owned tree absent".
 *
 * How it clears: it does not, in place. A tree is `close()`d on every outcome
 * including `unconfirmed-exit`, and closing is INVALIDATING — every method on
 * that tree refuses afterwards, so a backend has no way to re-query the
 * SPECIFIC stale tree to prove it emptied. Spawning an unrelated fresh CLI
 * proves nothing about the stale tree either, which is exactly the
 * false-admission bug this latch exists to close. Recovery therefore matches
 * §6.5's own documented remedy — the user restarts, which reconstructs the
 * backend and with it a fresh, unset latch.
 */
export function createUnconfirmedExitLatch(backendId: string): UnconfirmedExitLatch {
  let latched = false
  return {
    isLatched: () => latched,
    noteOutcome: (outcome) => {
      if (outcome.kind !== "unconfirmed-exit") return
      console.warn(
        `agent/run: ${backendId} run exited unconfirmed; latching this backend unhealthy until it is restarted (§6.5)`,
      )
      latched = true
    },
  }
}
```

Export both from `src/agent/run/index.ts`.

- [ ] **Step 3: Write tests for both**

Create `src/agent/run/model/degraded-run.test.ts` and `src/agent/run/model/unconfirmed-exit-latch.test.ts`. Move the corresponding assertions out of `claude-backend.test.ts` (degraded-run behavior; the latch's lock-out of `startTurn` and `healthCheck`). Add:

```ts
test("the latch stays unset for every non-unconfirmed outcome", () => {
  const latch = createUnconfirmedExitLatch("claude")
  latch.noteOutcome({ kind: "completed", finalText: "x", usage: null, sessionId: "s" })
  latch.noteOutcome({ kind: "cancelled", exitConfirmed: true })
  latch.noteOutcome({ kind: "backend-error", message: "m", sessionId: null })
  expect(latch.isLatched()).toBe(false)
})

test("the latch is sticky once an unconfirmed exit is noted", () => {
  const latch = createUnconfirmedExitLatch("claude")
  latch.noteOutcome({ kind: "unconfirmed-exit" })
  latch.noteOutcome({ kind: "completed", finalText: "x", usage: null, sessionId: "s" })
  expect(latch.isLatched()).toBe(true)
})
```

- [ ] **Step 4: Create the `query/` sub-module**

```bash
mkdir -p src/agent/claude/query/model
rtk git mv src/agent/claude/model/query-fn.ts src/agent/claude/query/model/query-options.ts
rtk git mv src/agent/claude/model/query-fn.test.ts src/agent/claude/query/model/query-options.test.ts
rtk git mv src/agent/claude/model/session-plan.ts src/agent/claude/query/model/session-options.ts
rtk git mv src/agent/claude/model/session-plan.test.ts src/agent/claude/query/model/session-options.test.ts
rtk git mv src/agent/claude/model/spawn-adopt.ts src/agent/claude/query/model/spawn-adopt.ts
```

Split `createRealQueryFn` out of `query-options.ts` into a new `src/agent/claude/query/model/query-fn.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeQueryFn } from "agent/claude/types"

/**
 * Production seam: the real SDK `query`. The SDK's `Query` satisfies
 * {@link ClaudeQuery} structurally, so this assigns WITHOUT a cast on purpose —
 * a cast would silently absorb future SDK signature drift instead of failing
 * the typecheck.
 */
export function createRealQueryFn(): ClaudeQueryFn {
  return (params) => query(params)
}
```

Rename `makeSpawnAndAdopt` → `createSpawnAndAdopt` in `spawn-adopt.ts` and at both call sites. Update its `logLabel` arguments from `"agent/query-fn"` to `"agent/query"` and from `"agent/health"` to `"agent/probe"`.

- [ ] **Step 5: Create `src/agent/claude/query/model/can-use-tool.ts`**

This dedups the adapter copied into `query-fn.ts:59-62` and `health.ts:136-138`.

```ts
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { PermissionResultLike } from "agent/confinement"

type Policy = (toolName: string, input: Record<string, unknown>, blockedPath?: string) => PermissionResultLike

/**
 * Adapt a shared confinement policy to the SDK's `canUseTool` callback. The
 * shared tier deliberately declares its own `PermissionResultLike` rather than
 * importing the SDK's `PermissionResult`, so this one-way adapter is where the
 * vendor shape is put back on — in the vendor tier, where the SDK type is
 * already in scope.
 */
export function createCanUseTool(policy: Policy): CanUseTool {
  return async (toolName, input, options) => {
    const decision = policy(toolName, input, options.blockedPath)
    return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
  }
}
```

Use it in both `buildQueryOptions` and `buildProbeOptions`.

Create `src/agent/claude/query/index.ts`:

```ts
export { createRealQueryFn } from "./model/query-fn"
export { buildQueryOptions } from "./model/query-options"
export type { QueryOptionDeps } from "./model/query-options"
export { planToSessionOptions } from "./model/session-options"
export { createSpawnAndAdopt } from "./model/spawn-adopt"
export { createCanUseTool } from "./model/can-use-tool"
```

- [ ] **Step 6: Create the `backend/` sub-module**

```bash
mkdir -p src/agent/claude/backend/model
rtk git mv src/agent/claude/model/claude-backend.ts src/agent/claude/backend/model/backend.ts
rtk git mv src/agent/claude/model/claude-backend.test.ts src/agent/claude/backend/model/backend.test.ts
rtk git mv src/agent/claude/model/backend-id.ts src/agent/claude/backend/model/backend-id.ts
rtk git mv src/agent/claude/model/errors.ts src/agent/claude/backend/model/errors.ts
rtk git mv src/agent/claude/model/errors.test.ts src/agent/claude/backend/model/errors.test.ts
```

Create `src/agent/claude/backend/model/capabilities.ts` with `claudeCapabilities` moved verbatim out of `health.ts:13-29`, then `rtk git rm src/agent/claude/model/health.ts src/agent/claude/model/health.test.ts` (their remaining content moved in Task 4).

In `errors.ts`, delete `ABORTED` and `RESULT_ERROR` from `AgentErrorCode` and rewrite the doc comment that defended them — it now reads simply that `STREAM_FAILED` and `SPAWN_FAILED` are the codes raised at the SDK boundary. Keep the constructor override.

Repoint the one importer Task 2 left pointing at the old path: in `src/agent/claude/run/model/drive-stream.ts`, change `import { ClaudeSdkError } from "agent/claude/model/errors"` to `import { ClaudeSdkError } from "agent/claude/backend"`.

- [ ] **Step 7: Rewrite `backend.ts`**

```ts
export function createClaudeBackend(deps: ClaudeBackendDeps): AgentBackend {
  const cancels = new WeakMap<AgentRun, () => Promise<void>>()
  const unhealthy = createUnconfirmedExitLatch(CLAUDE_BACKEND_ID)

  return {
    startTurn(task: AgentTask): AgentRun {
      if (unhealthy.isLatched()) {
        return createDegradedRun(
          task.fence,
          "backend is unhealthy: a prior run's exit was never confirmed (§6.5)",
        )
      }

      const abortController = new AbortController()
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        console.warn("agent/claude-backend: processTreeFactory failed, run degraded:", tree.message)
        return createDegradedRun(task.fence, tree.message)
      }

      const options = buildQueryOptions(task, {
        abortController,
        processTree: tree,
        pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
        hasReparsePoint: deps.hasReparsePoint,
      })

      const { run, cancel } = startAgentRun(
        task.fence,
        createClaudeDriver({ queryFn: deps.queryFn, prompt: buildPrompt(task), options }),
        { processTree: tree, abortController, wait: deps.wait, confirmTimeoutMs: deps.confirmTimeoutMs },
      )
      cancels.set(run, cancel)

      // `startTurn` mints `tree`, so `startTurn` owns releasing it. Close on
      // EVERY terminal kind including `unconfirmed-exit`: that kind names our
      // inability to CONFIRM the exit, not a reason to keep the tree open, and
      // closing arms Windows' kill-on-close for any survivor. `outcome` never
      // rejects, and it only settles AFTER exit confirmation has finished
      // reading `activeProcesses()`, so this cannot race that read.
      void run.outcome.then((outcome) => {
        tree.close()
        unhealthy.noteOutcome(outcome)
      })

      return run
    },

    async cancel(run: AgentRun): Promise<void> {
      const runCancel = cancels.get(run)
      if (runCancel === undefined) return // not a run this backend created -> safe no-op
      await runCancel()
    },

    healthCheck(): Promise<AgentInfo> {
      if (unhealthy.isLatched()) {
        // Report the latch instead of probing: a probe would spawn a fresh,
        // unrelated CLI that can only attest to its OWN health, never to
        // whether the stale tree is gone.
        return Promise.resolve({
          backendId: CLAUDE_BACKEND_ID,
          health: { status: "unhealthy-unconfirmed-exit" },
          account: null,
        })
      }
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        // Probe anyway rather than reporting a false "not-installed": no owned
        // tree exists here, but that says nothing about whether the CLI is
        // installed. `startTurn` already refuses a real turn on this same
        // failure, so no paid turn can start on a wrong "ready".
        console.warn(
          "agent/claude-backend: processTreeFactory failed for healthCheck(), probing without adoption:",
          tree.message,
        )
        return probeClaudeHealth(deps.queryFn, { abortController: new AbortController(), processTree: null })
      }
      return probeClaudeHealth(deps.queryFn, { abortController: new AbortController(), processTree: tree })
    },

    capabilities(): BackendCapabilities {
      return claudeCapabilities()
    },

    sessionScope(input: SessionScopeInput): string {
      return deriveSessionScope(CLAUDE_BACKEND_ID, input)
    },
  }
}
```

Create `src/agent/claude/backend/index.ts` exporting `createClaudeBackend`, `claudeCapabilities`, `probeClaudeHealth`, `CLAUDE_BACKEND_ID`, `ClaudeSdkError`.

- [ ] **Step 8: Update `src/agent/claude/index.ts`**

Repoint its imports to the new sub-modules. The exported surface — `createClaudeBackend`, `createRealQueryFn`, `createProductionClaudeBackend`, `createProductionClaudeBackendDeps`, and the three types — must not change.

- [ ] **Step 9: Verify `agent/claude/model/` is gone**

Run: `ls src/agent/claude/model 2>/dev/null; ls src/agent/model 2>/dev/null`
Expected: both report "No such file or directory".

- [ ] **Step 10: Verify the shared tier has no vendor import**

Run: `rtk grep "claude-agent-sdk" src/agent/run src/agent/confinement src/agent/session src/agent/health`
Expected: no matches. A match means shared/vendor separation was violated — fix before committing.

- [ ] **Step 11: Run the full suite and commit**

Run: `bun test` (the WHOLE suite, not just `src/agent`) → `0 fail`.
Run: `bunx tsc --noEmit` → no output.

```bash
rtk git add -A src/agent && rtk git commit -m "refactor(agent): move query and backend assembly into vendor sub-modules"
```

---

### Task 7: Comment pass

Structural work is done and green. This task changes only prose.

**Files:** every file under `src/agent/`.

- [ ] **Step 1: Remove review archaeology**

Go file by file. Delete every reference to a review finding number and to superseded code, and rewrite the claim it defended as a present-tense invariant. Examples of the transformation:

- `// finding [22]'s downstream half — a 0 read only counts once ownershipConfirmed() is true` → `// A zero read counts as a confirmed exit only together with ownershipConfirmed(): on its own it cannot distinguish "the tree drained" from "nothing was ever adopted into it".`
- `// finding [30]: sticky, per-backend-instance latch...` → keep the whole explanation, drop the `finding [30]:` prefix.
- `// Previously duplicated as a private const BACKEND_ID in both health.ts and claude-backend.ts...` → delete entirely; the const now has one home and the paragraph describes a bug that no longer exists.
- `// finding [26] half b: give the probe the same process ownership a turn gets` → `// The probe gets the same process ownership a turn does: a fresh, independently owned tree from the same factory startTurn uses.`

Search for the markers: `rtk grep -n "finding \[" src/agent` and `rtk grep -n "Previously\|used to\|the old\|before this fix" src/agent`.

- [ ] **Step 2: Move the rung-3 divergence comment**

The ~35-line divergence analysis currently on `runCancelLadder` in the deleted `agent-run.ts` must end up verbatim on `runCancelLadder` in `src/agent/run/model/engine.ts`, replacing the `NOTE FOR TASK 7` placeholder written in Task 2. Retrieve it from git if needed:

```bash
rtk git show HEAD~5:src/agent/claude/model/agent-run.ts
```

CLAUDE.md mandates a documented divergence live in a code comment — this and the win32 drive-letter note in `path-containment.ts` are the two that must survive intact.

- [ ] **Step 3: Verify nothing but comments changed**

Run: `rtk git diff --stat`
Then inspect: `rtk git diff -U0 src/agent | rtk grep "^[+-]" | rtk grep -v "^[+-][[:space:]]*\(//\|\*\|/\*\)"`
Expected: no output. Any line here is a non-comment change that does not belong in this commit — revert it.

- [ ] **Step 4: Run the suite and commit**

Run: `bun test` → `0 fail`. Run `bunx tsc --noEmit` → clean.

```bash
rtk git add src/agent && rtk git commit -m "docs(agent): replace review archaeology with present-tense invariants"
```

---

### Task 8: Architecture docs

**Files:**
- Modify: `docs/architecture/code-structure.md` (the per-file `agent/` list, ~lines 281-312)
- Modify: `docs/architecture/modules.md`, `docs/architecture/overview.md`
- Modify: `docs/architecture/flows/chats.md`, `flows/generation-turn.md`, `flows/launch.md`

- [ ] **Step 1: Run the architecture-update skill**

Invoke the `architecture:architecture-update` skill. It finds and updates the affected documents against their Source anchors.

- [ ] **Step 2: Verify no stale path survives**

Run: `rtk grep -n "agent/claude/model\|agent/model/\|startClaudeRun\|makeConfinementPolicy\|makeSpawnAndAdopt\|tool-tables\|probeHealth" docs/architecture/`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
rtk git add docs/architecture && rtk git commit -m "docs(architecture): resync agent/ anchors after the module restructure"
```

---

### Task 9: Pull request

- [ ] **Step 1: Push the branch**

```bash
rtk git push -u origin phase-5-agent
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "refactor(agent): restructure into shared and vendor sub-modules" --body "..."
```

The body must state: what moved and why, the shared/vendor split invariant, the four collapsed duplications, the one behavior delta (`BashOutput`/`KillShell` → `op: "run"`), and the verification evidence (test counts before and after, `tsc` clean). End it with the Claude Code attribution footer.

---

## Final verification

- [ ] `bun test` — 0 fail, pass count >= 143, `expect()` count >= 278
- [ ] `bunx tsc --noEmit` — clean
- [ ] `ls src/agent/model src/agent/claude/model` — both gone
- [ ] `rtk grep "claude-agent-sdk" src/agent/run src/agent/confinement src/agent/session src/agent/health` — no matches
- [ ] `rtk grep -rn "\bmake[A-Z]" src/agent` — no matches
- [ ] `rtk grep -rn "finding \[" src/agent` — no matches

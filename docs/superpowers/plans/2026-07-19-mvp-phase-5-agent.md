# MVP Phase 5 — `agent/` (ClaudeBackend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Before any code action, load `/reatom` and `/errore` (CLAUDE.md mandate).

**Goal:** Build `src/agent/` — the `ClaudeBackend` implementation of the mechanism-blind `AgentBackend` port over `@anthropic-ai/claude-agent-sdk@0.3.212` — plus the domain-free `infrastructure/process/` Job-Object process-tree primitive it consumes, so a fenced generation turn can run inside a staging workspace, stream normalized `AgentEvent`s, be confined by an in-process `canUseTool` veto, resume/seed a session, and be cancelled with confirmed process-tree exit.

**Architecture:** `agent/` is a **non-Reatom, injected adapter** (like `host/` and `gate/`): plain functions and one factory `createClaudeBackend(deps)`. It holds no atoms, owns no long-lived Reatom lifetimes, and consumes the pre-existing `AgentEvent`/`TokenUsage`/`TurnFence` types from `entities/turn` — it never redefines them. It declares its own contracts (`AgentBackend`, `AgentTask`, `AgentRun`, `AgentInfo`, `BackendCapabilities`) in `agent/types.ts`; phase 6 lifts those verbatim into `core/ports/` and the composition root injects the backend (roadmap Cross-phase registry). The SDK is reached only through an injected `ClaudeQueryFn` seam, exactly as `host/` reaches `Bun.spawn` through an injected `SpawnFn` — so every test scripts the SDK without a live CLI or login. The one process/OS capability the adapter needs — placing the SDK-spawned CLI in an owned Job Object and reading its live descendant count — is domain-free (it knows nothing of Pages or Turns) and therefore lands in `infrastructure/process/`, consumed by `agent/` and injectable as a fake (Spike I).

**Tech Stack:** TypeScript on Bun ≥1.3.14; `@anthropic-ai/claude-agent-sdk` ^0.3.212 (installed 0.3.212, bundling Claude CLI 2.1.212); `errore` ^0.14.1; `bun:ffi` against `kernel32.dll` for the Job Object; `bun test` + `bun x tsc --noEmit`. **MVP ships only `ClaudeBackend`** — Codex is out of scope (v1.0, quota-blocked; roadmap Out-of-scope). Do not build a Codex backend.

## Global Constraints

Inherited from `docs/superpowers/plans/2026-07-17-termcraft-mvp-roadmap.md` "Global constraints" (repeated by reference; every task obeys them). The load-bearing subset for this phase:

- **Bun** `>=1.3.14`. Tests: `bun test`. Typecheck: `bun x tsc --noEmit` (TS 7.0.2). Both green at the phase boundary.
- **errore is mandatory:** `import * as errore from "errore"`; errors as values (`Error | T` unions); `createTaggedError` for domain errors; `.catch()`/`errore.try` **only** at the SDK/FFI boundary (spawn, streaming, `abort`, `dlopen`); flat control flow; one-line `instanceof Error` early returns; no `let`+try; `| null` for optional values; log any swallowed error (rule 21).
- **Reatom v1001:** the adapter is **non-Reatom**. It holds no atoms and no `withConnectHook` lifetimes; process/transaction lifetimes are owned explicitly (hardening §3.8: "critical process/transaction lifetimes are owned by supervisors, not connection hooks"). No `wrap(...)` boundaries appear here because there are no async atoms — if a future task adds one, `wrap` at that boundary is required. State this in code comments where a reader might expect an atom.
- **Module DAG** (`docs/architecture/code-structure.md`): `agent/` imports only `entities/` and `infrastructure/`, never `core`/`store`/`gate`/`host`/`ui`. Port types in `agent/types.ts` are **vendor-blind** — they must not import any `@anthropic-ai/*` type (phase 6 lifts them into `core/ports/`, and `core` imports no SDK). SDK types appear only inside `agent/model/*` files. `infrastructure/process/` is domain-free (passes the "knows what a Page is?" test — a Job Object owning a PID does not).
- **Module folder shape** (`CLAUDE.md`): `types.ts` + `index.ts` at the module root; all logic under `model/`; never loose at the root; atomic single-purpose functions.
- **Non-page identities are UUIDv7** (lowercase). Session ids are the backend's opaque native form (not ours to mint).
- **Confinement is defense-in-depth, not the wall** (master §6.1): correctness is the Gate accepting only what landed in staging. The `canUseTool` veto is a second layer.
- **Language/commits:** English everywhere. One commit per task, `feat:`/`test:`/`docs:` prefix, ending with the repo co-author trailer:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: <session-url>
  ```

- **Architecture docs:** when this phase lands, move the `AgentBackend`/`agent` Source anchors in `docs/architecture/` from spec sections to real source paths (final task).

---

## Normative sources

| Area | Source |
|---|---|
| `AgentBackend`/`AgentTask`/`AgentRun`, confinement, `AgentEvent` normalization | master §6.1 (lines ~787–893) |
| Turn protocol, turn workspace, sessions, fencing, late events | master §6.2 (lines ~895–956) |
| Turn workspace = cwd + only writable root; session checkpoint `(chatId, sessionScopeId)` + `recordCount`/`prefixHash`; `SessionWorkspaceBinding`; §6.5 cancel ladder | turn-durability §6.2–6.5, §7.3 |
| `sessionScopeId` (four change-triggers; effort excluded); fresh-seed ≤32 records / ≤64 KiB drop-oldest | production-storage-identity §6.2 |
| healthCheck states; §6.5 cancel; watchdog/deadline are kernel-owned | master §9 |
| `canUseTool` deny-by-default confirmed; SDK shape; 5 attack cases; compiled-binary parity | Spike H (`docs/spikes/08-agent-confinement/FINDINGS.md`) |
| Job Object + `QueryInformationJobObject` confirmed exit; crash-path is the open gap → `unhealthy_unconfirmed_exit`; `taskkill /T` reaches detached descendants | Spike I (`docs/spikes/09-process-tree/FINDINGS.md`) |
| Module placement (adapter vs infrastructure; consumer declares the port; "knows what a Page is" test) | `docs/architecture/code-structure.md` §4–§8, §11 |
| Existing types the adapter CONSUMES | `src/entities/turn/types.ts` (`AgentEvent`, `AgentToolOp`, `TokenUsage`, `TurnFence`) |
| Sibling-adapter conventions to mirror | `src/host/supervisor/` (`SpawnFn`/`SpawnedChild` seam, `types.ts` port block, `model/errors.ts` tagged errors, `model/transport.ts` async-generator streaming, `model/clock.ts` injected timer) |

## Real SDK surface (verified in the installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts@0.3.212`)

The adapter binds to exactly these exported names. Cited so no task guesses the surface:

- **Entry:** `query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`. For MVP each attempt is one `query()` call with a `string` prompt.
- **`Query`** `extends AsyncGenerator<SDKMessage, void>`; the control method used here is `interrupt(): Promise<SDKControlInterruptResponse | undefined>` (streaming-input only — MVP prefers `Options.abortController` for cancellation, which works in single-prompt mode).
- **`Options`** fields used: `abortController?: AbortController`, `canUseTool?: CanUseTool`, `cwd?: string`, `additionalDirectories?: string[]`, `allowedTools?: string[]`, `disallowedTools?: string[]`, `tools?: string[] | { type:'preset'; preset:'claude_code' }`, `resume?: string`, `sessionId?: string`, `forkSession?: boolean`, `model?: string`, `effort?: EffortLevel`, `systemPrompt?: string | string[] | {…}`, `permissionMode?: PermissionMode`, `settingSources?: SettingSource[]` (**pass `[]` for SDK isolation** — no user/project settings leak in), `pathToClaudeCodeExecutable?: string`, `env?`, `includePartialMessages?: boolean`, `maxTurns?: number`, `stderr?: (data: string) => void`, and the process-ownership seam **`spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`**.
- **`CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; blockedPath?: string; toolUseID: string; requestId: string; … }) => Promise<PermissionResult | null>`**.
- **`PermissionResult = { behavior:'allow'; updatedInput?; … } | { behavior:'deny'; message: string; interrupt?; … }`**.
- **`SDKMessage`** union; the members the normalizer reads:
  - `SDKAssistantMessage { type:'assistant'; message: BetaMessage; session_id; uuid; error?: SDKAssistantMessageError }` — `message.content: Array<BetaContentBlock>`; relevant blocks `{ type:'text'; text }`, `{ type:'thinking'; thinking; signature }`, `{ type:'tool_use'; id; name; input }`.
  - `SDKResultSuccess { type:'result'; subtype:'success'; result: string; usage: NonNullableUsage; modelUsage: Record<string,ModelUsage>; total_cost_usd; permission_denials; session_id }`.
  - `SDKResultError { type:'result'; subtype:'error_during_execution'|'error_max_turns'|'error_max_budget_usd'|'error_max_structured_output_retries'; usage; errors: string[]; permission_denials; session_id }`.
  - `SDKSystemMessage { type:'system'; subtype:'init'; apiKeySource: ApiKeySource; model; tools; session_id }` — the **health-probe signal** (installed + CLI reached, emitted before any model turn).
  - `SDKAuthStatusMessage { type:'auth_status'; isAuthenticating; error? }` and `SDKAssistantMessageError` value `'authentication_failed'` — the **not-logged-in signals**.
  - `SDKPartialAssistantMessage { type:'stream_event'; event: BetaRawMessageStreamEvent }` — only with `includePartialMessages:true`; **MVP leaves partials off** and normalizes from complete assistant blocks.
- **`EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'`**; **`ModelUsage { inputTokens; outputTokens; contextWindow; … }`**; `NonNullableUsage` keys `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- **`SpawnedProcess`** (Node `ChildProcess` satisfies it): `{ stdin: Writable; stdout: Readable; readonly killed; readonly exitCode; readonly signalCode?; kill(signal); on/once/off('exit'|'error', …) }`. **`SpawnOptions { command; args; cwd?; env; signal: AbortSignal }`** (the `signal` here is the SDK's *forwarded* graceful signal, fired only after the SDK's stdin-EOF + ~2 s grace).
- **`AbortError extends Error`** (exported) — the SDK's abort marker.
- **No dedicated health/auth export** exists (confirmed by grep of all exports): `healthCheck()` is implemented as a minimal probe `query()` read up to `system:init` / an auth signal, then aborted — mirroring Spike H Step 1's live `claude -p` check.

The **`spawnClaudeCodeProcess` seam is load-bearing**: because the SDK otherwise spawns the CLI internally and never hands out its PID, this option lets the adapter spawn the CLI itself (a real `ChildProcess` with a `.pid`), immediately `adopt(pid)` it into an owned Job Object, and thereby satisfy §6.5's "owned process tree" + confirmed-exit requirement.

---

## Architecture decisions locked before tasks

1. **`AgentRun` consumption model — async iterable of fenced events + a terminal-outcome promise.**

   ```ts
   interface AgentRun {
     readonly fence: TurnFence
     readonly events: AsyncIterable<FencedEvent>          // live stream; kernel resets its 120 s watchdog per item
     readonly outcome: Promise<AgentRunOutcome>           // resolves after the stream closes AND (for cancel) confirmed exit; never rejects
   }
   ```

   Chosen over a callback+promise pair because (a) it mirrors `host/`'s `frames: AsyncIterable<PreviewFrame>` + `start()/stop(): Promise` split, the established sibling-adapter shape; (b) Reatom's kernel-side consumption (`wrap`, `onEvent`, `withAsyncData`, phase 6) binds an async iterable and a promise naturally; (c) it keeps ordering/backpressure explicit and lets the kernel await finalization independently of draining events. Each item is a `FencedEvent { fence: TurnFence; event: AgentEvent }` so the kernel can drop stale-fence events authoritatively (turn-durability §6.4 "wraps every callback with `{turnId, attempt, leaseNonce}`"). The adapter additionally **suppresses emission** after its own terminal/cancel, so a scripted SDK that keeps yielding produces nothing downstream.

2. **One attempt per `AgentRun`; the kernel drives the retry loop.** Master §6.3 / turn-durability §7.3: ≤3 gate retries are kernel-orchestrated. So `startTurn(task)` runs exactly one attempt; a retry is a fresh `startTurn` with `task.fence.attempt+1` and `task.session = { kind:"resume", sessionId: prevOutcome.sessionId }`. `outcome` resolving only **after confirmed process-tree exit** is precisely what lets the kernel safely start the next attempt (master §6.3 "continues … only after the prior attempt's process tree is confirmed exited").

3. **Process-tree ownership is `infrastructure/process/` (domain-free); the §6.5 cancel *ladder* is `agent/` (domain-aware).** The Job Object primitive (`adopt(pid)`, `terminate()`, `activeProcesses()`, `close()`) knows nothing of Turns → infrastructure. The graceful→terminate→hard-kill→confirm sequence with fence retirement and the `unhealthy_unconfirmed_exit` outcome is domain-aware → `agent/model/agent-run.ts`. Both converge on the same OS-read confirmation.

4. **Agent vs. store vs. kernel boundary for sessions** (the shared-logic split the task demands):
   - **`agent/` (this phase):** derives the opaque `sessionScopeId` (pure hash of `backendId | account | model | workspaceIdentity`; **effort excluded**, storage-identity §6.2); maps a `SessionPlan` to SDK options (`resume:sessionId` vs a seeded prompt); reports the backend's opaque `session_id` in the run outcome; reports `sessionWorkspaceBinding`.
   - **`store/` (phase 4):** persists the checkpoint `(chatId, sessionScopeId) → { sessionId, recordCount, prefixHash }` in `workspace.local.toml`; computes `recordCount`/`prefixHash`; runs resume-eligibility comparison; selects the bounded fresh-seed records (≤32 / ≤64 KiB, drop oldest whole).
   - **`core/` (phase 6):** orchestrates — asks `store` for a checkpoint match + seed, constructs `AgentTask.session`, calls `agent.sessionScope(...)`/`startTurn(...)`, and after the terminal record is durably appended advances the checkpoint using `outcome.sessionId`.

5. **Claude is `sessionWorkspaceBinding: "rebindable"`** — see Unresolved-questions Q1 for the caveat and the conservative fallback.

---

## File structure

```text
src/
  agent/
    types.ts                       # VENDOR-BLIND port shapes (lifted to core/ports/ in phase 6)
    index.ts                       # public entry: createClaudeBackend + type re-exports; production wiring
    model/
      errors.ts                    # tagged AgentError family (SDK/FFI-boundary domain errors)
      errors.test.ts
      path-containment.ts          # realpath staging-root containment (hostile paths, Spike H + Spike F junction backstop)
      path-containment.test.ts
      confinement.ts               # canUseTool deny-by-default policy (allow in-staging file tools; deny Bash/web/unknown)
      confinement.test.ts
      tool-op.ts                   # SDK tool name -> AgentToolOp + primary-arg -> target
      tool-op.test.ts
      normalize.ts                 # SDKMessage -> AgentEvent[] (thinking/text->reasoning, tool_use->tool, result->final+usage)
      normalize.test.ts
      session-scope.ts             # deriveSessionScope (pure; effort excluded)
      session-scope.test.ts
      session-plan.ts              # SessionPlan -> SDK options + seeded-prompt assembly
      session-plan.test.ts
      query-fn.ts                  # ClaudeQueryFn seam + production `query` wrapper + option builder
      query-fn.test.ts
      agent-run.ts                 # AgentRun impl: drive query, stamp fence, normalize, suppress late, confirm exit, §6.5 cancel ladder
      agent-run.test.ts
      health.ts                    # healthCheck probe + classification; capabilities()
      health.test.ts
      claude-backend.ts            # assemble AgentBackend; createClaudeBackend(deps)
      claude-backend.test.ts
  infrastructure/
    process/
      types.ts                     # ProcessTree, ProcessTreeFactory port; ProcessTreeError
      index.ts
      model/
        job-object.ts              # bun:ffi kernel32 Job Object (Spike I) + createFakeProcessTree for tests
        job-object.test.ts         # unit tests against the fake + FFI struct-offset assertions
        job-object.integration.test.ts   # Windows-gated synthetic-tree test (Spike I mechanism)
```

No loose files at any module root; every logic file sits under `model/`. `agent/` has a single `model/` (one adapter, flat concern files — mirrors `host/supervisor/model/`), not premature sub-submodules.

---

## Tasks (TDD, dependency-ordered)

Legend: **[ordered]** must follow its predecessors; **[parallel]** may be built alongside its siblings once its stated dependencies exist.

Dependency summary:

```text
T1 types.ts ─┬─> T2 errors ─┐
             ├─> T5 path-containment ─> T6 confinement ─┐
             ├─> T7 tool-op ─> T8 normalize ────────────┤
             ├─> T9 session-scope                        │
             ├─> T10 session-plan                        │
             └───────────────────────────────┐          │
T3 process/types ─> T4 job-object ────────────┤          │
                                              ├─> T11 query-fn ─> T12 agent-run ─┐
                                              │                                  ├─> T14 claude-backend ─> T15 index ─> T16 docs
                                              └─> T13 health ────────────────────┘
```

Parallelizable clusters once **T1** and **T3** land: **{T2, T5, T7, T9, T10}** and **{T4}** run independently. **T6** needs T5; **T8** needs T7; **T11** needs T6+T10+T4; **T12** needs T8+T11+T4; **T13** needs T11; **T14** needs T9+T10+T12+T13.

---

### Task 1: `agent/types.ts` — vendor-blind port shapes **[ordered, first]**

**Files:**
- Create: `src/agent/types.ts`
- Test: `src/agent/types.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `AgentToolOp`, `TokenUsage`, `TurnFence` from `src/entities/turn` (already exist — never redefined here).
- Produces: `AgentBackend`, `AgentTask`, `AgentRun`, `FencedEvent`, `AgentRunOutcome`, `AgentInfo`, `AgentHealthState`, `BackendCapabilities`, `ModelCapability`, `ReasoningEffort`, `SessionWorkspaceBinding`, `SessionPlan`, `SeedRecord`, `SessionScopeInput`. All consumed verbatim by later tasks and by phase 6.

Rationale reminders baked into doc comments: no `@anthropic-ai/*` import (vendor-blind); `ReasoningEffort` mirrors the SDK's `EffortLevel` values without importing them.

- [ ] **Step 1: Write the failing test** (`src/agent/types.test.ts`) — a pure type-shape guard plus a value that exercises the union discriminants:

```ts
import { expect, test } from "bun:test"
import type {
  AgentBackend,
  AgentRunOutcome,
  AgentTask,
  ReasoningEffort,
  SessionPlan,
} from "./types"
import type { TurnFence } from "../entities/turn"

test("AgentTask carries workspace, fence, model, effort, and a session plan", () => {
  const fence: TurnFence = { turnId: "019a", attempt: 0, leaseNonce: "n0" }
  const task: AgentTask = {
    fence,
    workspacePath: "C:\\state\\sandboxes\\k\\turns\\019a\\workspace",
    systemPrompt: "role + rules",
    userMessage: "make the gauge red",
    model: "claude-opus-4-8",
    effort: "high",
    session: { kind: "fresh", seed: [] },
  }
  expect(task.session.kind).toBe("fresh")
})

test("AgentRunOutcome discriminates the four terminal shapes", () => {
  const outcomes: AgentRunOutcome[] = [
    { kind: "completed", finalText: "done", usage: null, sessionId: "sess-1" },
    { kind: "backend-error", message: "auth failed" },
    { kind: "cancelled", exitConfirmed: true },
    { kind: "unconfirmed-exit" },
  ]
  expect(outcomes.map((o) => o.kind)).toEqual([
    "completed",
    "backend-error",
    "cancelled",
    "unconfirmed-exit",
  ])
})

test("ReasoningEffort matches the SDK EffortLevel value set", () => {
  const all: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"]
  expect(all).toHaveLength(5)
})

test("a SessionPlan is either resume or fresh", () => {
  const resume: SessionPlan = { kind: "resume", sessionId: "s", promptDelta: null }
  const fresh: SessionPlan = { kind: "fresh", seed: [{ role: "user", text: "hi" }] }
  expect([resume.kind, fresh.kind]).toEqual(["resume", "fresh"])
})

test("AgentBackend exposes the five port methods", () => {
  const shape: (keyof AgentBackend)[] = [
    "startTurn",
    "cancel",
    "healthCheck",
    "capabilities",
    "sessionScope",
  ]
  expect(shape).toHaveLength(5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/types.test.ts`
Expected: FAIL — `Cannot find module "./types"`.

- [ ] **Step 3: Write `src/agent/types.ts`**

```ts
import type { AgentEvent, TokenUsage, TurnFence } from "../entities/turn"

/**
 * Reasoning effort the picker offers (master §3.6). Mirrors the Claude Agent
 * SDK's `EffortLevel` value set WITHOUT importing it — this file is a port
 * lifted verbatim into `core/ports/` in phase 6, and `core` imports no vendor
 * SDK. The ClaudeBackend maps these to the SDK's `effort` option.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"

/** Whether a stored vendor session can rebind to a new turn workspace (turn-durability §6.3). */
export type SessionWorkspaceBinding = "rebindable" | "fixed"

/** One record from the bounded fresh-session seed (storage-identity §6.2). Assembled by store/kernel. */
export interface SeedRecord {
  readonly role: "user" | "agent"
  readonly text: string
}

/**
 * The kernel's resume-vs-fresh decision, made from the store checkpoint
 * comparison (storage-identity §6.2) and handed to the adapter. The adapter
 * does not decide it — it only encodes it into SDK options.
 */
export type SessionPlan =
  | { readonly kind: "resume"; readonly sessionId: string; readonly promptDelta: string | null }
  | { readonly kind: "fresh"; readonly seed: readonly SeedRecord[] }

/**
 * One fenced turn's task (master §6.1–6.2). `workspacePath` is the unique turn
 * workspace — the backend's cwd AND only writable root (turn-durability §6.3).
 * `userMessage` already carries selection + pins framing (assembled by the
 * kernel). `session` is the resume/fresh decision (see `SessionPlan`).
 */
export interface AgentTask {
  readonly fence: TurnFence
  readonly workspacePath: string
  readonly systemPrompt: string
  readonly userMessage: string
  readonly model: string
  readonly effort: ReasoningEffort
  readonly session: SessionPlan
}

/** A normalized event stamped with its run's fence so the kernel can drop stale ones (§6.4). */
export interface FencedEvent {
  readonly fence: TurnFence
  readonly event: AgentEvent
}

/**
 * One attempt's terminal outcome. Resolves only after the event stream closes
 * and (for cancel) confirmed process-tree exit (§6.4–6.5). Never a thrown
 * error — errors are values. `sessionId` is the backend's opaque session id the
 * kernel/store use to advance the checkpoint (storage-identity §6.2).
 */
export type AgentRunOutcome =
  | {
      readonly kind: "completed"
      readonly finalText: string
      readonly usage: TokenUsage | null
      readonly sessionId: string
    }
  | { readonly kind: "backend-error"; readonly message: string; readonly sessionId: string | null }
  | { readonly kind: "cancelled"; readonly exitConfirmed: true }
  | { readonly kind: "unconfirmed-exit" }

/** One fenced run handle (master §6.1). Live events + a terminal-outcome promise. */
export interface AgentRun {
  readonly fence: TurnFence
  readonly events: AsyncIterable<FencedEvent>
  readonly outcome: Promise<AgentRunOutcome>
}

/** Health states (master §9 + turn-durability §6.5). `sandbox-degraded` is Codex-only (never Claude). */
export type AgentHealthState =
  | { readonly status: "ready" }
  | { readonly status: "not-installed" }
  | { readonly status: "not-logged-in" }
  | { readonly status: "sandbox-degraded"; readonly detail: string }
  | { readonly status: "unhealthy-unconfirmed-exit" }

/**
 * The healthCheck result (master §6.1). `account` is a NON-SECRET stable
 * account discriminator feeding `sessionScope` (storage-identity §6.2); null
 * when the backend cannot supply one (which safely disables cross-process resume).
 */
export interface AgentInfo {
  readonly backendId: string
  readonly health: AgentHealthState
  readonly account: string | null
}

/** One model's supported efforts (master §6.1 "models × efforts"). */
export interface ModelCapability {
  readonly model: string
  readonly efforts: readonly ReasoningEffort[]
}

/** Static backend capabilities (master §6.1). */
export interface BackendCapabilities {
  readonly backendId: string
  readonly models: readonly ModelCapability[]
  /** Confinement mechanism descriptor: Claude uses the in-process `canUseTool` veto (Spike H). */
  readonly confinement: "canUseTool" | "sandbox"
  readonly sessionWorkspaceBinding: SessionWorkspaceBinding
}

/**
 * Inputs to the opaque session scope (storage-identity §6.2). Effort is
 * deliberately ABSENT — changing effort must not change scope. `account` comes
 * from a prior healthCheck; `workspaceIdentity` is the backend workspace
 * discriminator (turn-durability §6.3 item 4).
 */
export interface SessionScopeInput {
  readonly account: string | null
  readonly model: string
  readonly workspaceIdentity: string
}

/**
 * The mechanism-blind backend port (master §6.1). Phase 6 lifts this verbatim
 * into `core/ports/`; the composition root injects the concrete ClaudeBackend.
 */
export interface AgentBackend {
  /** Run ONE fenced attempt bound to `task.workspacePath`. The kernel drives retries. */
  startTurn(task: AgentTask): AgentRun
  /** Fire the abort + §6.5 process-tree ladder; resolves only after confirmed exit (or marks unhealthy). */
  cancel(run: AgentRun): Promise<void>
  /** installed? logged in? (sandbox effective? — Codex only). Cheap probe; no paid turn. */
  healthCheck(): Promise<AgentInfo>
  /** models × efforts; confinement mechanism; session-workspace binding. */
  capabilities(): BackendCapabilities
  /** Opaque session scope for the store checkpoint key. Pure; effort excluded. */
  sessionScope(input: SessionScopeInput): string
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/types.test.ts && bun x tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/types.ts src/agent/types.test.ts
rtk git commit -m "feat(agent-5): vendor-blind AgentBackend port shapes"
```

---

### Task 2: `agent/model/errors.ts` — tagged SDK/FFI-boundary errors **[parallel: needs T1]**

**Files:**
- Create: `src/agent/model/errors.ts`
- Test: `src/agent/model/errors.test.ts`

**Interfaces:**
- Produces: `ClaudeSdkError`, `AgentHealthProbeError`, `AgentErrorCode`. Internal-only tagged errors used at the `query`/stream/abort boundary; never escape as thrown exceptions past the adapter — they map to `AgentRunOutcome`/`AgentEvent` values.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import * as errore from "errore"
import { AgentHealthProbeError, ClaudeSdkError } from "./errors"

test("ClaudeSdkError carries a stable code and preserves cause", () => {
  const cause = new Error("spawn ENOENT")
  const err = new ClaudeSdkError({ code: "SPAWN_FAILED", reason: "cli not found", cause })
  expect(err).toBeInstanceOf(Error)
  expect(err._tag).toBe("ClaudeSdkError")
  expect(err.code).toBe("SPAWN_FAILED")
  expect(err.findCause(Error)).toBe(cause)
})

test("isAbortError walks a ClaudeSdkError cause chain", () => {
  class Timeout extends errore.createTaggedError({
    name: "Timeout",
    message: "t",
    extends: errore.AbortError,
  }) {}
  const wrapped = new ClaudeSdkError({ code: "STREAM_FAILED", reason: "aborted", cause: new Timeout({}) })
  expect(errore.isAbortError(wrapped)).toBe(true)
})

test("AgentHealthProbeError distinguishes the probe boundary", () => {
  const err = new AgentHealthProbeError({ reason: "no init message" })
  expect(err._tag).toBe("AgentHealthProbeError")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/errors.test.ts`
Expected: FAIL — `Cannot find module "./errors"`.

- [ ] **Step 3: Write `src/agent/model/errors.ts`**

```ts
import * as errore from "errore"

/**
 * Stable codes for failures raised at the Claude SDK boundary (spawn, stream,
 * abort). These are INTERNAL — the adapter maps them to `AgentRunOutcome` /
 * `AgentEvent` values and never rethrows past its own surface.
 */
export type AgentErrorCode = "SPAWN_FAILED" | "STREAM_FAILED" | "ABORTED" | "RESULT_ERROR"

/** A failure crossing the `@anthropic-ai/claude-agent-sdk` boundary. */
export class ClaudeSdkError extends errore.createTaggedError({
  name: "ClaudeSdkError",
  message: "Claude SDK failure [$code]: $reason",
}) {}

/** A healthCheck probe failure (installed/logged-in classification). */
export class AgentHealthProbeError extends errore.createTaggedError({
  name: "AgentHealthProbeError",
  message: "Agent health probe failed: $reason",
}) {}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/agent/model/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/errors.ts src/agent/model/errors.test.ts
rtk git commit -m "feat(agent-5): tagged SDK-boundary domain errors"
```

---

### Task 3: `infrastructure/process/types.ts` — process-tree port **[parallel, independent]**

**Files:**
- Create: `src/infrastructure/process/types.ts`
- Create: `src/infrastructure/process/index.ts`
- Test: `src/infrastructure/process/types.test.ts`

**Interfaces:**
- Produces: `ProcessTree`, `ProcessTreeFactory`, `ProcessTreeError`. Domain-free (Spike I). `ProcessTree` owns one Job Object; `adopt(pid)` assigns a process, `activeProcesses()` reads `JobObjectBasicAccountingInformation.ActiveProcesses`, `terminate()` calls `TerminateJobObject`, `close()` releases the handle.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import type { ProcessTree, ProcessTreeFactory } from "./types"
import { ProcessTreeError } from "./types"

test("ProcessTreeError is a tagged error", () => {
  const e = new ProcessTreeError({ reason: "CreateJobObjectW failed" })
  expect(e).toBeInstanceOf(Error)
  expect(e._tag).toBe("ProcessTreeError")
})

test("a ProcessTree exposes adopt/activeProcesses/terminate/close", () => {
  const shape: (keyof ProcessTree)[] = ["adopt", "activeProcesses", "terminate", "close"]
  expect(shape).toHaveLength(4)
})

test("ProcessTreeFactory creates a tree or returns the tagged error", () => {
  const make: ProcessTreeFactory = () => new ProcessTreeError({ reason: "unsupported platform" })
  const t = make()
  expect(t).toBeInstanceOf(ProcessTreeError)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/process/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/infrastructure/process/types.ts`**

```ts
import * as errore from "errore"

/** A Job Object / process-group primitive failure (Spike I). Domain-free. */
export class ProcessTreeError extends errore.createTaggedError({
  name: "ProcessTreeError",
  message: "Process-tree failure: $reason",
}) {}

/**
 * One owned process tree (Windows Job Object with kill-on-close, Spike I). Knows
 * nothing about Turns or Pages — it owns a set of OS processes. `adopt` assigns a
 * spawned pid; `activeProcesses` is a genuine OS read of the live descendant count
 * (`QueryInformationJobObject` / `JobObjectBasicAccountingInformation`), NOT a PID
 * poll; `terminate` hard-kills the whole tree; `close` releases the handle
 * (kill-on-close then fires for any survivor).
 */
export interface ProcessTree {
  /** Assign a spawned process (and its future descendants) into the job. */
  adopt(pid: number): ProcessTreeError | null
  /** Live owned-descendant count from the OS, or a tagged error if the handle is gone. */
  activeProcesses(): ProcessTreeError | number
  /** Hard-kill the whole tree (`TerminateJobObject`). */
  terminate(): ProcessTreeError | null
  /** Release the job handle. */
  close(): void
}

/** Constructs a fresh owned tree, or a typed failure on an unsupported platform. */
export type ProcessTreeFactory = () => ProcessTreeError | ProcessTree
```

- [ ] **Step 4: Write `src/infrastructure/process/index.ts`**

```ts
export type { ProcessTree, ProcessTreeFactory } from "./types"
export { ProcessTreeError } from "./types"
export { createJobObjectTree, createFakeProcessTree } from "./model/job-object"
```

(the two `job-object` exports land in Task 4; `index.ts` referencing them now is fine — the file compiles once T4 exists. If you build T3 before T4, temporarily export only the types line and add the model line in T4's step 4.)

- [ ] **Step 5: Run tests + commit**

Run: `bun test src/infrastructure/process/types.test.ts`
Expected: PASS.

```bash
rtk git add src/infrastructure/process/types.ts src/infrastructure/process/index.ts src/infrastructure/process/types.test.ts
rtk git commit -m "feat(agent-5): domain-free process-tree port"
```

---

### Task 4: `infrastructure/process/model/job-object.ts` — Job Object FFI + fake **[ordered: needs T3]**

**Files:**
- Create: `src/infrastructure/process/model/job-object.ts`
- Test: `src/infrastructure/process/model/job-object.test.ts` (unit — fake + struct-offset assertions, cross-platform)
- Test: `src/infrastructure/process/model/job-object.integration.test.ts` (Windows-gated synthetic-tree, Spike I)

**Interfaces:**
- Consumes: `ProcessTree`, `ProcessTreeError` from `../types`.
- Produces: `createJobObjectTree(): ProcessTreeError | ProcessTree` (real `bun:ffi` kernel32 impl); `createFakeProcessTree(script): ProcessTree` (deterministic test double whose `activeProcesses()` follows a scripted count sequence).

Implementation notes pinned by Spike I: `CreateJobObjectW` → `SetInformationJobObject` with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (144 bytes; `LimitFlags` at offset 16 = `0x2000` `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) → `AssignProcessToJobObject(OpenProcess(PROCESS_TERMINATE|PROCESS_SET_QUOTA, 0, pid))`. `activeProcesses` = `QueryInformationJobObject(JobObjectBasicAccountingInformation)` reading the `ActiveProcesses` DWORD. Confirmation for the application-driven path is a genuine read (Spike I: 3→0 in 0–1 ms). The assign-before-descendant-spawn race is not OS-guaranteed (no `CREATE_SUSPENDED` from Bun) — after `adopt`, re-read `activeProcesses()` to verify membership rather than assume it.

- [ ] **Step 1: Write the failing unit test** (`job-object.test.ts`)

```ts
import { expect, test } from "bun:test"
import { buildExtendedLimitInfo, createFakeProcessTree, KILL_ON_JOB_CLOSE } from "./job-object"

test("the extended-limit struct is 144 bytes with kill-on-close at offset 16", () => {
  const buf = buildExtendedLimitInfo()
  expect(buf.byteLength).toBe(144)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  expect(view.getUint32(16, true)).toBe(KILL_ON_JOB_CLOSE)
})

test("a fake tree replays a scripted active-process count then zero", () => {
  const tree = createFakeProcessTree({ counts: [3, 3, 0] })
  expect(tree.adopt(1234)).toBeNull()
  expect(tree.activeProcesses()).toBe(3)
  expect(tree.activeProcesses()).toBe(3)
  expect(tree.terminate()).toBeNull()
  expect(tree.activeProcesses()).toBe(0)
})

test("a fake tree can be scripted to never confirm exit", () => {
  const tree = createFakeProcessTree({ counts: [2], neverZero: true })
  tree.terminate()
  expect(tree.activeProcesses()).toBe(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/process/model/job-object.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/infrastructure/process/model/job-object.ts`**

Structure (real code — the FFI arm follows Spike I verbatim; keep the fake and the struct builder cross-platform so the unit test runs everywhere):

```ts
import * as errore from "errore"
import type { ProcessTree } from "../types"
import { ProcessTreeError } from "../types"

export const KILL_ON_JOB_CLOSE = 0x2000
const JobObjectExtendedLimitInformation = 9
const JobObjectBasicAccountingInformation = 1
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100

/** The 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only LimitFlags set (Spike I). */
export function buildExtendedLimitInfo(): Uint8Array {
  const buf = new Uint8Array(144)
  new DataView(buf.buffer).setUint32(16, KILL_ON_JOB_CLOSE, true)
  return buf
}

/** Deterministic test double: `activeProcesses()` walks the scripted `counts`. */
export function createFakeProcessTree(script: {
  counts: number[]
  neverZero?: boolean
}): ProcessTree {
  let i = 0
  const read = () => {
    const value = script.counts[Math.min(i, script.counts.length - 1)] ?? 0
    if (i < script.counts.length - 1) i += 1
    return value
  }
  return {
    adopt: () => null,
    activeProcesses: () => read(),
    terminate: () => {
      if (!script.neverZero) script.counts.push(0)
      return null
    },
    close: () => {},
  }
}

/**
 * The real Windows Job Object tree via `bun:ffi` (Spike I). Returns a typed
 * error on non-Windows or when `dlopen`/`CreateJobObjectW` fails.
 */
export function createJobObjectTree(): ProcessTreeError | ProcessTree {
  if (process.platform !== "win32") {
    return new ProcessTreeError({ reason: "Job Object requires win32" })
  }
  const opened = errore.try(
    () => openKernel32(),
    (e) => new ProcessTreeError({ reason: "dlopen kernel32 failed", cause: e instanceof Error ? e : undefined }),
  )
  if (opened instanceof ProcessTreeError) return opened
  // ... CreateJobObjectW -> SetInformationJobObject(buildExtendedLimitInfo) ...
  // Return a ProcessTree whose methods call OpenProcess/AssignProcessToJobObject,
  // QueryInformationJobObject (ActiveProcesses), TerminateJobObject, CloseHandle,
  // each wrapped so any FFI failure becomes a ProcessTreeError value (never a throw).
  // Full FFI body mirrors docs/spikes/09-process-tree/src/main.ts.
  return buildTreeFromHandles(opened)
}
```

> The executor copies the concrete `dlopen`/symbol table and the eight `kernel32` calls from `docs/spikes/09-process-tree/src/main.ts` (already proven). Keep every FFI call wrapped with `errore.try` → `ProcessTreeError` (errore boundary rule). Do not let a raw throw escape.

- [ ] **Step 4: Add `index.ts` model exports** (if deferred in T3): ensure `src/infrastructure/process/index.ts` exports `createJobObjectTree`, `createFakeProcessTree`.

- [ ] **Step 5: Write the Windows-gated integration test** (`job-object.integration.test.ts`)

```ts
import { expect, test } from "bun:test"
import { createJobObjectTree } from "./job-object"
import type { ProcessTree } from "../types"

const win = process.platform === "win32"

test.if(win)("adopts a real child and confirms 0 active after terminate (Spike I)", async () => {
  const tree = createJobObjectTree()
  expect(tree).not.toBeInstanceOf(Error)
  const t = tree as ProcessTree
  const child = Bun.spawn({ cmd: ["bun", "-e", "setInterval(()=>{},1000)"] })
  expect(t.adopt(child.pid!)).toBeNull()
  expect(t.activeProcesses()).toBeGreaterThanOrEqual(1)
  t.terminate()
  // Spike I: ActiveProcesses reaches 0 within a millisecond of the kill.
  const after = t.activeProcesses()
  expect(after).toBe(0)
  t.close()
})
```

- [ ] **Step 6: Run tests + commit**

Run: `bun test src/infrastructure/process/model/job-object.test.ts && bun x tsc --noEmit`
Expected: unit PASS (integration skipped off-Windows via `test.if`).

```bash
rtk git add src/infrastructure/process
rtk git commit -m "feat(agent-5): Job Object process-tree via bun:ffi (Spike I)"
```

---

### Task 5: `agent/model/path-containment.ts` — staging-root containment **[parallel: needs T1]**

**Files:**
- Create: `src/agent/model/path-containment.ts`
- Test: `src/agent/model/path-containment.test.ts`

**Interfaces:**
- Produces: `isInsideStaging(candidate: string, stagingRoot: string): boolean`. Pure/deterministic: resolves both paths and tests containment; rejects the four Spike H hostile shapes and applies the Spike F junction/reparse backstop.

Spike-earned rules folded in: Spike H's five cases (in-staging write; absolute-outside; `../`-relative escape; Bash target; web) — the path check must accept only the first and reject absolute-outside and `../`-escape. Spike F: `realpathSync` comparison is the escape check, and junction/reparse detection needs the `GetFileAttributesW` + `FILE_ATTRIBUTE_REPARSE_POINT` backstop rather than `isSymbolicLink()` alone. For MVP the reparse backstop is a hook (`options.hasReparsePoint?`) so the pure logic is testable cross-platform and the real FFI backstop injects on Windows.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import path from "node:path"
import { isInsideStaging } from "./path-containment"

const staging = path.resolve("C:\\state\\turns\\019a\\workspace")

test("Spike H case 1: an in-staging path is inside", () => {
  expect(isInsideStaging(path.join(staging, "pages", "main.tsx"), staging)).toBe(true)
})

test("Spike H case 2: an absolute path outside staging is rejected", () => {
  expect(isInsideStaging("C:\\Users\\Khmil\\ok.txt", staging)).toBe(false)
})

test("Spike H case 3: a ../ escape is rejected", () => {
  expect(isInsideStaging(path.join(staging, "..", "escape.txt"), staging)).toBe(false)
})

test("a sibling directory sharing a prefix is rejected (workspace-evil vs workspace)", () => {
  expect(isInsideStaging("C:\\state\\turns\\019a\\workspace-evil\\x.txt", staging)).toBe(false)
})

test("the staging root itself is inside", () => {
  expect(isInsideStaging(staging, staging)).toBe(true)
})

test("Spike F: a junction/reparse point inside staging is rejected via the backstop hook", () => {
  const target = path.join(staging, "link", "x.txt")
  expect(isInsideStaging(target, staging, { hasReparsePoint: () => true })).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/path-containment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/model/path-containment.ts`**

```ts
import path from "node:path"

/**
 * True only when `candidate` resolves to a location inside `stagingRoot`
 * (master §6.1 confinement; Spike H). Uses path normalization + a boundary-safe
 * prefix test (a trailing separator prevents `workspace-evil` from matching
 * `workspace`). The optional `hasReparsePoint` backstop rejects a junction/
 * reparse point on the path (Spike F: `isSymbolicLink()` alone is insufficient
 * on Windows); production injects the `GetFileAttributesW` FFI check.
 */
export function isInsideStaging(
  candidate: string,
  stagingRoot: string,
  options?: { hasReparsePoint?: (p: string) => boolean },
): boolean {
  const root = path.resolve(stagingRoot)
  const target = path.resolve(candidate)
  if (target !== root) {
    const withSep = root.endsWith(path.sep) ? root : root + path.sep
    if (!target.startsWith(withSep)) return false
  }
  if (options?.hasReparsePoint?.(target) === true) return false
  return true
}
```

> Note on `realpathSync`: the pure function above compares resolved *logical* paths. The Spike F requirement — resolve symlinks/junctions with `realpathSync` and compare — is applied by the caller (the confinement policy, Task 6) when the path exists on disk; `hasReparsePoint` is the additional reparse backstop. Case-insensitive matching on Windows is handled by `path.resolve` normalization; if a fixture exposes a case gap, lower-case both operands before the prefix test and note the divergence in a comment.

- [ ] **Step 4: Run tests**

Run: `bun test src/agent/model/path-containment.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/path-containment.ts src/agent/model/path-containment.test.ts
rtk git commit -m "feat(agent-5): staging-root path containment (Spike H/F)"
```

---

### Task 6: `agent/model/confinement.ts` — `canUseTool` deny-by-default policy **[ordered: needs T5]**

**Files:**
- Create: `src/agent/model/confinement.ts`
- Test: `src/agent/model/confinement.test.ts`

**Interfaces:**
- Consumes: `isInsideStaging` (T5).
- Produces: `makeConfinementPolicy(stagingRoot: string, options?): (toolName, input) => PermissionResultLike`, where `PermissionResultLike = { behavior:'allow' } | { behavior:'deny'; message: string }` — the shape the SDK's `canUseTool` returns. Later wrapped into the actual `CanUseTool` in query-fn (T11).

Policy (master §6.1; Spike H): allow file tools (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `LS`) only when the primary path argument is inside staging; deny `Bash`, `BashOutput`, `KillShell`, and every web tool (`WebFetch`, `WebSearch`); deny any unknown tool by default (deny-by-default). Uses the tool's `blockedPath` (from SDK options) when present, else the primary path arg. Spike H proved the callback fires before every one of 6 tool-use attempts across the 5 cases — the policy is the decision function behind that callback.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import path from "node:path"
import { makeConfinementPolicy } from "./confinement"

const staging = path.resolve("C:\\state\\turns\\019a\\workspace")
const policy = makeConfinementPolicy(staging)

test("allows a Write inside staging (Spike H case 1)", () => {
  const r = policy("Write", { file_path: path.join(staging, "pages", "main.tsx"), content: "x" })
  expect(r.behavior).toBe("allow")
})

test("denies a Write to an absolute path outside staging (Spike H case 2)", () => {
  const r = policy("Write", { file_path: "C:\\Users\\Khmil\\ok.txt", content: "x" })
  expect(r.behavior).toBe("deny")
})

test("denies a ../ relative escape (Spike H case 3)", () => {
  const r = policy("Write", { file_path: path.join(staging, "..", "escape.txt"), content: "x" })
  expect(r.behavior).toBe("deny")
})

test("denies Bash outright (Spike H case 4)", () => {
  const r = policy("Bash", { command: "echo BASHPROBE > bash-probe.txt" })
  expect(r.behavior).toBe("deny")
})

test("denies WebFetch outright (Spike H case 5)", () => {
  const r = policy("WebFetch", { url: "https://example.com" })
  expect(r.behavior).toBe("deny")
})

test("denies an unknown tool by default", () => {
  const r = policy("SomeFutureTool", { anything: true })
  expect(r.behavior).toBe("deny")
})

test("allows a read-only tool with no path (e.g. Grep pattern) only when its path stays in staging", () => {
  const inside = policy("Grep", { pattern: "gauge", path: path.join(staging, "pages") })
  expect(inside.behavior).toBe("allow")
  const outside = policy("Grep", { pattern: "gauge", path: "C:\\Windows" })
  expect(outside.behavior).toBe("deny")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/confinement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/agent/model/confinement.ts`**

```ts
import { isInsideStaging } from "./path-containment"

export type PermissionResultLike =
  | { readonly behavior: "allow" }
  | { readonly behavior: "deny"; readonly message: string }

/** File tools whose primary path argument must stay inside staging. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"])
/** Tools denied outright regardless of arguments (master §6.1). */
const DENIED_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"])

/** Field names, in order, that carry a tool's primary path argument. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "notebookPath"] as const

function primaryPath(input: Record<string, unknown>, blockedPath?: string): string | null {
  if (typeof blockedPath === "string") return blockedPath
  for (const field of PATH_FIELDS) {
    const v = input[field]
    if (typeof v === "string") return v
  }
  return null
}

/**
 * The deny-by-default confinement decision behind the SDK `canUseTool` callback
 * (master §6.1; confirmed by Spike H). Allows file tools only when their path is
 * inside `stagingRoot`; denies Bash + web + unknown tools. Defense-in-depth — the
 * Gate is the load-bearing wall.
 */
export function makeConfinementPolicy(
  stagingRoot: string,
  options?: { hasReparsePoint?: (p: string) => boolean },
) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    blockedPath?: string,
  ): PermissionResultLike => {
    if (DENIED_TOOLS.has(toolName)) {
      return { behavior: "deny", message: `${toolName} is not permitted in a design turn` }
    }
    if (!FILE_TOOLS.has(toolName)) {
      return { behavior: "deny", message: `Tool ${toolName} is not on the design-turn allowlist` }
    }
    const target = primaryPath(input, blockedPath)
    if (target === null) {
      return { behavior: "deny", message: `${toolName} call has no resolvable path` }
    }
    if (!isInsideStaging(target, stagingRoot, options)) {
      return { behavior: "deny", message: `${toolName} target is outside the turn workspace` }
    }
    return { behavior: "allow" }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/agent/model/confinement.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/confinement.ts src/agent/model/confinement.test.ts
rtk git commit -m "feat(agent-5): deny-by-default canUseTool confinement policy (Spike H)"
```

---

### Task 7: `agent/model/tool-op.ts` — tool name → `AgentToolOp` + target **[parallel: needs T1]**

**Files:**
- Create: `src/agent/model/tool-op.ts`
- Test: `src/agent/model/tool-op.test.ts`

**Interfaces:**
- Consumes: `AgentToolOp` from `entities/turn`.
- Produces: `mapToolUse(name: string, input: Record<string, unknown>): { op: AgentToolOp; target: string }`. `read`→Read/Glob/LS; `edit`→Write/Edit/MultiEdit/NotebookEdit; `run`→Bash; `search`→Grep/WebSearch/WebFetch; else `other`. Target = primary path arg, else command/pattern/url, else `""` (master §6.1 "tool name → `op`, primary argument → `target`").

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { mapToolUse } from "./tool-op"

test("Write maps to edit with the file path as target", () => {
  expect(mapToolUse("Write", { file_path: "pages/main.tsx", content: "x" })).toEqual({
    op: "edit",
    target: "pages/main.tsx",
  })
})

test("Read maps to read", () => {
  expect(mapToolUse("Read", { file_path: "pages/main.tsx" }).op).toBe("read")
})

test("Bash maps to run with the command as target", () => {
  expect(mapToolUse("Bash", { command: "ls -la" })).toEqual({ op: "run", target: "ls -la" })
})

test("Grep maps to search with the pattern as target when no path", () => {
  expect(mapToolUse("Grep", { pattern: "gauge" })).toEqual({ op: "search", target: "gauge" })
})

test("an unknown tool maps to other with an empty target when nothing extractable", () => {
  expect(mapToolUse("Mystery", {})).toEqual({ op: "other", target: "" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/tool-op.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/tool-op.ts`**

```ts
import type { AgentToolOp } from "../../entities/turn"

const OP_BY_TOOL: Record<string, AgentToolOp> = {
  Read: "read",
  Glob: "read",
  LS: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "search",
}

const TARGET_FIELDS = ["file_path", "path", "notebook_path", "command", "pattern", "url"] as const

/** Map an SDK `tool_use` block to the UI's op + target (master §6.1). */
export function mapToolUse(
  name: string,
  input: Record<string, unknown>,
): { op: AgentToolOp; target: string } {
  const op = OP_BY_TOOL[name] ?? "other"
  const target = (() => {
    for (const field of TARGET_FIELDS) {
      const v = input[field]
      if (typeof v === "string") return v
    }
    return ""
  })()
  return { op, target }
}
```

- [ ] **Step 4: Run tests + commit**

Run: `bun test src/agent/model/tool-op.test.ts`
Expected: PASS.

```bash
rtk git add src/agent/model/tool-op.ts src/agent/model/tool-op.test.ts
rtk git commit -m "feat(agent-5): tool_use -> AgentToolOp/target mapping"
```

---

### Task 8: `agent/model/normalize.ts` — `SDKMessage` → `AgentEvent[]` **[ordered: needs T7]**

**Files:**
- Create: `src/agent/model/normalize.ts`
- Test: `src/agent/model/normalize.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `TokenUsage` from `entities/turn`; `mapToolUse` (T7). Imports the SDK message *types* (allowed inside `agent/model/`).
- Produces: `normalizeMessage(msg: SDKMessage): AgentEvent[]` — one SDK message may yield several events (an assistant message with N content blocks). Rules (master §6.1): `assistant` → for each block: `thinking`→`reasoning`, `text`→`reasoning`, `tool_use`→`tool` (via `mapToolUse`); `result` success → `final` + a `usage` event; `result` error → `error`; **unmapped messages → `[]` (dropped silently)**. Also `deriveUsage(result): TokenUsage | null`.

- [ ] **Step 1: Write the failing test** (scripted vendor event sequences — the mandated fake-SDK-event test)

```ts
import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { normalizeMessage } from "./normalize"

test("an assistant message with thinking, text, and tool_use yields reasoning, reasoning, tool", () => {
  const msg = {
    type: "assistant",
    session_id: "s1",
    uuid: "u1",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "thinking", thinking: "I will edit the gauge", signature: "sig" },
        { type: "text", text: "Editing now" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "pages/main.tsx", content: "x" } },
      ],
    },
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([
    { kind: "reasoning", text: "I will edit the gauge" },
    { kind: "reasoning", text: "Editing now" },
    { kind: "tool", op: "edit", target: "pages/main.tsx" },
  ])
})

test("a success result yields final then usage", () => {
  const msg = {
    type: "result",
    subtype: "success",
    result: "Updated the CPU gauge.",
    session_id: "s1",
    uuid: "u2",
    usage: { input_tokens: 1200, output_tokens: 340 },
    modelUsage: { "claude-opus-4-8": { inputTokens: 1200, outputTokens: 340, contextWindow: 200000 } },
    total_cost_usd: 0.02,
    permission_denials: [],
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([
    { kind: "final", text: "Updated the CPU gauge." },
    {
      kind: "usage",
      tokens: { inputTokens: 1200, outputTokens: 340, contextPercent: 1 },
    },
  ])
})

test("an error result yields a single error event", () => {
  const msg = {
    type: "result",
    subtype: "error_during_execution",
    session_id: "s1",
    uuid: "u3",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    errors: ["authentication_failed"],
    permission_denials: [],
  } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([{ kind: "error", message: "authentication_failed" }])
})

test("an unmapped system init message is dropped silently", () => {
  const msg = { type: "system", subtype: "init", session_id: "s1", uuid: "u4" } as unknown as SDKMessage
  expect(normalizeMessage(msg)).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/normalize.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/normalize.ts`**

```ts
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, TokenUsage } from "../../entities/turn"
import { mapToolUse } from "./tool-op"

/** Compute the 0–100 context-window share, or null when it cannot be derived (master §6.1). */
export function deriveUsage(result: Extract<SDKResultMessage, { subtype: "success" }>): TokenUsage | null {
  const usage = result.usage as { input_tokens?: number; output_tokens?: number } | undefined
  if (usage === undefined) return null
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const contextPercent = (() => {
    const models = Object.values(result.modelUsage ?? {})
    const window = models[0]?.contextWindow
    if (typeof window !== "number" || window <= 0) return null
    return Math.round(((inputTokens + outputTokens) / window) * 100)
  })()
  return { inputTokens, outputTokens, contextPercent }
}

/**
 * Normalize one vendor `SDKMessage` into zero or more `AgentEvent`s (master §6.1).
 * Thinking blocks + interim assistant text -> `reasoning`; `tool_use` -> `tool`;
 * a success result -> `final` + `usage`; an error result -> `error`. Any message
 * with no mapping yields `[]` — forward-compatible by default.
 */
export function normalizeMessage(msg: SDKMessage): AgentEvent[] {
  if (msg.type === "assistant") {
    const blocks = (msg.message?.content ?? []) as Array<Record<string, unknown>>
    const out: AgentEvent[] = []
    for (const block of blocks) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        out.push({ kind: "reasoning", text: block.thinking })
      } else if (block.type === "text" && typeof block.text === "string") {
        out.push({ kind: "reasoning", text: block.text })
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const { op, target } = mapToolUse(block.name, (block.input ?? {}) as Record<string, unknown>)
        out.push({ kind: "tool", op, target })
      }
    }
    return out
  }
  if (msg.type === "result") {
    if (msg.subtype === "success") {
      const usage = deriveUsage(msg)
      const events: AgentEvent[] = [{ kind: "final", text: msg.result }]
      if (usage !== null) events.push({ kind: "usage", tokens: usage })
      return events
    }
    const errors = (msg as { errors?: string[] }).errors ?? []
    return [{ kind: "error", message: errors[0] ?? `result ${msg.subtype}` }]
  }
  return []
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/model/normalize.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/normalize.ts src/agent/model/normalize.test.ts
rtk git commit -m "feat(agent-5): vendor SDKMessage -> AgentEvent normalization"
```

---

### Task 9: `agent/model/session-scope.ts` — opaque scope derivation **[parallel: needs T1]**

**Files:**
- Create: `src/agent/model/session-scope.ts`
- Test: `src/agent/model/session-scope.test.ts`

**Interfaces:**
- Consumes: `SessionScopeInput` (T1).
- Produces: `deriveSessionScope(backendId: string, input: SessionScopeInput): string`. Stable lowercase-hex SHA-256 over `backendId | account | model | workspaceIdentity` (storage-identity §6.2 four triggers). **Effort is not an input** — changing effort must not change scope. A null account yields a per-process-unique scope (safely disables cross-process resume, §6.2).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { deriveSessionScope } from "./session-scope"

const base = { account: "acct-1", model: "claude-opus-4-8", workspaceIdentity: "proj-key-abc" }

test("scope is stable for identical inputs", () => {
  expect(deriveSessionScope("claude", base)).toBe(deriveSessionScope("claude", base))
})

test("scope changes when the model changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(
    deriveSessionScope("claude", { ...base, model: "claude-sonnet-5" }),
  )
})

test("scope changes when the account changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(
    deriveSessionScope("claude", { ...base, account: "acct-2" }),
  )
})

test("scope changes when the backend changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(deriveSessionScope("codex", base))
})

test("a null account yields a unique, non-resumable scope each call", () => {
  const a = deriveSessionScope("claude", { ...base, account: null })
  const b = deriveSessionScope("claude", { ...base, account: null })
  expect(a).not.toBe(b)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/session-scope.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/session-scope.ts`**

```ts
import type { SessionScopeInput } from "../types"

/**
 * The opaque `sessionScopeId` for the store checkpoint key (storage-identity
 * §6.2). Changes iff backend, account, model, or workspace identity changes.
 * Effort is deliberately excluded. A null account produces a per-call unique
 * value, which safely disables cross-process resume for that backend (§6.2).
 */
export function deriveSessionScope(backendId: string, input: SessionScopeInput): string {
  const account = input.account ?? `unresumable:${Bun.randomUUIDv7()}`
  const material = [backendId, account, input.model, input.workspaceIdentity].join(" ")
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(material)
  return hasher.digest("hex")
}
```

- [ ] **Step 4: Run tests + commit**

Run: `bun test src/agent/model/session-scope.test.ts`
Expected: PASS.

```bash
rtk git add src/agent/model/session-scope.ts src/agent/model/session-scope.test.ts
rtk git commit -m "feat(agent-5): opaque session-scope derivation (storage-identity 6.2)"
```

---

### Task 10: `agent/model/session-plan.ts` — `SessionPlan` → SDK options **[parallel: needs T1]**

**Files:**
- Create: `src/agent/model/session-plan.ts`
- Test: `src/agent/model/session-plan.test.ts`

**Interfaces:**
- Consumes: `SessionPlan`, `AgentTask` (T1).
- Produces: `planToSessionOptions(plan: SessionPlan): { resume?: string; forkSession: false }` and `buildPrompt(task: AgentTask): string`. For `resume`, the SDK is told `resume: sessionId` and the prompt is the `promptDelta` (or the user message when null). For `fresh`, the seed records are rendered as a compact transcript block prepended to the user message (the SDK `query()` takes a single string prompt; the seed becomes leading context). Bounded-seed *selection* (≤32/≤64 KiB) is the store's job — this task only renders what it is handed.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import type { AgentTask } from "../types"
import { buildPrompt, planToSessionOptions } from "./session-plan"

const baseTask = (session: AgentTask["session"]): AgentTask => ({
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session,
})

test("a resume plan passes resume:sessionId and forkSession:false", () => {
  expect(planToSessionOptions({ kind: "resume", sessionId: "s9", promptDelta: null })).toEqual({
    resume: "s9",
    forkSession: false,
  })
})

test("a fresh plan carries no resume id", () => {
  expect(planToSessionOptions({ kind: "fresh", seed: [] })).toEqual({ forkSession: false })
})

test("a resume prompt uses the delta when present, else the user message", () => {
  const withDelta = baseTask({ kind: "resume", sessionId: "s", promptDelta: "gate errors: X" })
  expect(buildPrompt(withDelta)).toBe("gate errors: X")
  const noDelta = baseTask({ kind: "resume", sessionId: "s", promptDelta: null })
  expect(buildPrompt(noDelta)).toBe("make the gauge red")
})

test("a fresh prompt prepends the seed transcript before the user message", () => {
  const task = baseTask({
    kind: "fresh",
    seed: [
      { role: "user", text: "add a cpu gauge" },
      { role: "agent", text: "Added the CPU gauge." },
    ],
  })
  const prompt = buildPrompt(task)
  expect(prompt).toContain("add a cpu gauge")
  expect(prompt).toContain("Added the CPU gauge.")
  expect(prompt.endsWith("make the gauge red")).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/session-plan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/session-plan.ts`**

```ts
import type { AgentTask, SessionPlan } from "../types"

/** SDK session options for a plan. `forkSession:false` keeps the resumed session id stable. */
export function planToSessionOptions(plan: SessionPlan): { resume?: string; forkSession: false } {
  if (plan.kind === "resume") return { resume: plan.sessionId, forkSession: false }
  return { forkSession: false }
}

/**
 * The single-string prompt for one attempt. `resume` sends only the delta (or the
 * user message when the kernel supplied no delta — the SDK already holds history).
 * `fresh` prepends the bounded seed transcript (already selected by store) as
 * leading context, then the user message (storage-identity §6.2).
 */
export function buildPrompt(task: AgentTask): string {
  if (task.session.kind === "resume") {
    return task.session.promptDelta ?? task.userMessage
  }
  if (task.session.seed.length === 0) return task.userMessage
  const transcript = task.session.seed
    .map((r) => (r.role === "user" ? `User: ${r.text}` : `Assistant: ${r.text}`))
    .join("\n\n")
  return `${transcript}\n\n${task.userMessage}`
}
```

- [ ] **Step 4: Run tests + commit**

Run: `bun test src/agent/model/session-plan.test.ts`
Expected: PASS.

```bash
rtk git add src/agent/model/session-plan.ts src/agent/model/session-plan.test.ts
rtk git commit -m "feat(agent-5): SessionPlan -> SDK options + prompt assembly"
```

---

### Task 11: `agent/model/query-fn.ts` — `ClaudeQueryFn` seam + option builder **[ordered: needs T6, T10, T4]**

**Files:**
- Create: `src/agent/model/query-fn.ts`
- Test: `src/agent/model/query-fn.test.ts`

**Interfaces:**
- Consumes: `makeConfinementPolicy` (T6), `planToSessionOptions`/`buildPrompt` (T10), `ProcessTree`/`ProcessTreeFactory` (T3/T4), `AgentTask` (T1). Imports SDK `Options`, `query`, `SDKMessage`, `SpawnOptions`, `SpawnedProcess`, `AbortError`.
- Produces:
  - `ClaudeQuery` — the minimal seam: `AsyncIterable<SDKMessage>` + `interrupt(): Promise<unknown>`.
  - `ClaudeQueryFn = (params: { prompt: string; options: Options }) => ClaudeQuery`.
  - `createRealQueryFn(): ClaudeQueryFn` — wraps the SDK `query`.
  - `buildQueryOptions(task, deps): Options` — assembles cwd, `additionalDirectories:[]`, the wrapped `canUseTool`, `disallowedTools`, `settingSources:[]`, model, effort, systemPrompt, resume/forkSession, `abortController`, and **`spawnClaudeCodeProcess`** that spawns the CLI, `adopt`s its pid into the injected `ProcessTree`, and returns the child as a `SpawnedProcess`.

The `spawnClaudeCodeProcess` closure is where process-tree ownership is established. It spawns via `node:child_process.spawn` (a real `ChildProcess` satisfies `SpawnedProcess`), calls `processTree.adopt(child.pid)`, and returns `child`. That gives the §6.5 owned tree.

- [ ] **Step 1: Write the failing test** (option-builder behavior; the SDK is not invoked)

```ts
import { expect, test } from "bun:test"
import path from "node:path"
import type { AgentTask } from "../types"
import { buildQueryOptions } from "./query-fn"
import { createFakeProcessTree } from "../../infrastructure/process/index"

const staging = path.resolve("C:\\ws")
const task: AgentTask = {
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: staging,
  systemPrompt: "role + rules",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

test("options bind cwd to staging, isolate settings, and deny web/bash", () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
  })
  expect(opts.cwd).toBe(staging)
  expect(opts.additionalDirectories).toEqual([])
  expect(opts.settingSources).toEqual([])
  expect(opts.disallowedTools).toContain("Bash")
  expect(opts.disallowedTools).toContain("WebFetch")
  expect(opts.model).toBe("claude-opus-4-8")
  expect(opts.effort).toBe("high")
})

test("canUseTool denies an out-of-staging write and allows an in-staging edit", async () => {
  const opts = buildQueryOptions(task, {
    abortController: new AbortController(),
    processTree: createFakeProcessTree({ counts: [1] }),
  })
  const deny = await opts.canUseTool!("Write", { file_path: "C:\\Users\\x\\ok.txt", content: "y" }, {
    signal: new AbortController().signal,
    toolUseID: "t1",
    requestId: "r1",
  })
  expect(deny?.behavior).toBe("deny")
  const allow = await opts.canUseTool!("Write", { file_path: path.join(staging, "pages", "main.tsx"), content: "y" }, {
    signal: new AbortController().signal,
    toolUseID: "t2",
    requestId: "r2",
  })
  expect(allow?.behavior).toBe("allow")
})

test("a resume plan sets resume and forkSession:false", () => {
  const opts = buildQueryOptions(
    { ...task, session: { kind: "resume", sessionId: "s9", promptDelta: null } },
    { abortController: new AbortController(), processTree: createFakeProcessTree({ counts: [1] }) },
  )
  expect(opts.resume).toBe("s9")
  expect(opts.forkSession).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/query-fn.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/query-fn.ts`**

```ts
import { spawn } from "node:child_process"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Options, SDKMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"
import type { ProcessTree } from "../../infrastructure/process/index"
import type { AgentTask } from "../types"
import { makeConfinementPolicy } from "./confinement"
import { planToSessionOptions } from "./session-plan"

/** The minimal SDK surface the run loop consumes (injection seam, mirrors host's SpawnedChild). */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
}

/** Injected query seam: production wraps the SDK `query`, tests script an async generator. */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => ClaudeQuery

/** Production seam: the real SDK `query`. */
export function createRealQueryFn(): ClaudeQueryFn {
  return (params) => query(params) as unknown as ClaudeQuery
}

const DISALLOWED = ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"]

export interface QueryOptionDeps {
  readonly abortController: AbortController
  readonly processTree: ProcessTree
  /** Optional override for the CLI path in a compiled binary (Spike H compiled-parity). */
  readonly pathToClaudeCodeExecutable?: string
  /** Reparse backstop injected on Windows (Spike F). */
  readonly hasReparsePoint?: (p: string) => boolean
}

/**
 * Build the SDK `Options` for one fenced attempt. Binds cwd + only-writable-root
 * to staging, isolates settings (`settingSources:[]`), wires the deny-by-default
 * `canUseTool` veto (Spike H), and installs `spawnClaudeCodeProcess` so the CLI is
 * spawned by us and adopted into the owned Job Object (Spike I / §6.5).
 */
export function buildQueryOptions(task: AgentTask, deps: QueryOptionDeps): Options {
  const policy = makeConfinementPolicy(task.workspacePath, { hasReparsePoint: deps.hasReparsePoint })
  const sessionOpts = planToSessionOptions(task.session)
  const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // `options.signal` is the SDK's forwarded graceful signal — safe to pass.
      signal: options.signal,
    })
    if (typeof child.pid === "number") deps.processTree.adopt(child.pid)
    return child as unknown as SpawnedProcess
  }
  return {
    cwd: task.workspacePath,
    additionalDirectories: [],
    settingSources: [],
    permissionMode: "default",
    disallowedTools: DISALLOWED,
    model: task.model,
    effort: task.effort,
    systemPrompt: task.systemPrompt,
    abortController: deps.abortController,
    includePartialMessages: false,
    ...(deps.pathToClaudeCodeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable }
      : {}),
    ...sessionOpts,
    canUseTool: async (toolName, input, options) => {
      const decision = policy(toolName, input, options.blockedPath)
      return decision.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
    },
    spawnClaudeCodeProcess,
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/model/query-fn.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/query-fn.ts src/agent/model/query-fn.test.ts
rtk git commit -m "feat(agent-5): SDK query seam + confined option builder + process adoption"
```

---

### Task 12: `agent/model/agent-run.ts` — run loop, fencing, exit confirmation, §6.5 cancel ladder **[ordered: needs T8, T11, T4]**

**Files:**
- Create: `src/agent/model/agent-run.ts`
- Test: `src/agent/model/agent-run.test.ts`

**Interfaces:**
- Consumes: `normalizeMessage` (T8), `ClaudeQueryFn`/`buildQueryOptions` (T11), `ProcessTree` (T3), `buildPrompt` (T10), `AgentTask`/`AgentRun`/`FencedEvent`/`AgentRunOutcome`/`TurnFence` (T1), `ClaudeSdkError` (T2). Imports the SDK `AbortError` type.
- Produces:
  - `startClaudeRun(task, deps): { run: AgentRun; cancel: () => Promise<void> }` where `deps = { queryFn, processTree, abortController, wait, confirmTimeoutMs? }`.
  - The run drives the query generator, normalizes each message to `FencedEvent`s stamped with `task.fence`, suppresses emission once terminal/cancelled, resolves `outcome` only after `confirmExit()` returns 0, and implements the §6.5 ladder.

Behavior pinned:
- Every yielded item is `{ fence: task.fence, event }`.
- A `final`/`error` result closes the stream; the loop then confirms process-tree exit (`activeProcesses()` polled with `wait` up to the 5 s budget); `completed`/`backend-error` outcome carries the SDK `session_id`.
- **Late events:** after the stream reaches a terminal result OR cancel begins, no further `FencedEvent`s are emitted even if the scripted query keeps yielding (turn-durability §6.4 "a callback arriving after retirement is late").
- **Cancel ladder (§6.5):** (1) `abortController.abort(new TurnAbortError())` and stop non-terminal emission; (2) wait ≤5 s for `activeProcesses()===0`; (3) `processTree.terminate()` and wait ≤5 s; (4) re-read; if still >0 → `unconfirmed-exit`; else `cancelled{exitConfirmed:true}`. errore: the abort uses a tagged error extending `errore.AbortError` so `isAbortError` detects it; SDK generator throws are wrapped `.catch → ClaudeSdkError` and mapped to a terminal `error` event + `backend-error` outcome.

- [ ] **Step 1: Write the failing test** (scripted query fake + fake process tree)

```ts
import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentTask, FencedEvent } from "../types"
import { startClaudeRun } from "./agent-run"
import type { ClaudeQuery } from "./query-fn"
import { createFakeProcessTree } from "../../infrastructure/process/index"

const task: AgentTask = {
  fence: { turnId: "t1", attempt: 0, leaseNonce: "n0" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "make the gauge red",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

function scriptedQuery(messages: SDKMessage[], onInterrupt?: () => void): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m
    },
    interrupt: async () => onInterrupt?.(),
  }
}

const assistant = {
  type: "assistant",
  session_id: "s1",
  uuid: "u1",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text: "editing" }, { type: "tool_use", id: "x", name: "Write", input: { file_path: "C:\\ws\\pages\\main.tsx" } }] },
} as unknown as SDKMessage
const success = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s1",
  uuid: "u2",
  usage: { input_tokens: 10, output_tokens: 2 },
  modelUsage: {},
  total_cost_usd: 0,
  permission_denials: [],
} as unknown as SDKMessage

test("a successful run streams fenced events then a completed outcome after confirmed exit", async () => {
  const { run } = startClaudeRun(task, {
    queryFn: () => scriptedQuery([assistant, success]),
    processTree: createFakeProcessTree({ counts: [1, 0] }),
    abortController: new AbortController(),
    wait: async () => {},
  })
  const got: FencedEvent[] = []
  for await (const ev of run.events) got.push(ev)
  expect(got.every((e) => e.fence.turnId === "t1")).toBe(true)
  expect(got.map((e) => e.event.kind)).toEqual(["reasoning", "tool", "final", "usage"])
  const outcome = await run.outcome
  expect(outcome).toEqual({ kind: "completed", finalText: "done", usage: null, sessionId: "s1" })
})

test("events after the terminal result are suppressed (late-event drop)", async () => {
  const late = { ...assistant, uuid: "u3" } as SDKMessage
  const { run } = startClaudeRun(task, {
    queryFn: () => scriptedQuery([success, late]),
    processTree: createFakeProcessTree({ counts: [0] }),
    abortController: new AbortController(),
    wait: async () => {},
  })
  const kinds: string[] = []
  for await (const ev of run.events) kinds.push(ev.event.kind)
  expect(kinds).toEqual(["final"])
})

test("cancel confirms exit and resolves cancelled", async () => {
  const tree = createFakeProcessTree({ counts: [2] })
  const { run, cancel } = startClaudeRun(task, {
    queryFn: () => scriptedQuery([assistant]),
    processTree: tree,
    abortController: new AbortController(),
    wait: async () => {},
  })
  await cancel()
  expect(await run.outcome).toEqual({ kind: "cancelled", exitConfirmed: true })
})

test("cancel that cannot confirm exit resolves unconfirmed-exit", async () => {
  const tree = createFakeProcessTree({ counts: [2], neverZero: true })
  const { run, cancel } = startClaudeRun(task, {
    queryFn: () => scriptedQuery([assistant]),
    processTree: tree,
    abortController: new AbortController(),
    wait: async () => {},
  })
  await cancel()
  expect(await run.outcome).toEqual({ kind: "unconfirmed-exit" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/agent-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/agent-run.ts`**

Implement the run driver. Key structure (executor fills the body per the pinned behavior; use flat errore control flow; abort uses a tagged `TurnAbortError extends errore.AbortError`):

```ts
import * as errore from "errore"
import type { AgentRun, AgentRunOutcome, AgentTask, FencedEvent } from "../types"
import type { ProcessTree } from "../../infrastructure/process/index"
import type { ClaudeQuery } from "./query-fn"
import { normalizeMessage } from "./normalize"
import { deriveUsage } from "./normalize"
import { ClaudeSdkError } from "./errors"

class TurnAbortError extends errore.createTaggedError({
  name: "TurnAbortError",
  message: "turn cancelled",
  extends: errore.AbortError,
}) {}

export interface RunDeps {
  readonly queryFn: (params: { prompt: string; options: unknown }) => ClaudeQuery
  readonly processTree: ProcessTree
  readonly abortController: AbortController
  /** Injectable delay for the §6.5 waits; production = (ms) => Bun.sleep(ms). */
  readonly wait: (ms: number) => Promise<void>
  readonly confirmTimeoutMs?: number
  readonly options?: unknown // buildQueryOptions(task, …) supplied by claude-backend
  readonly prompt?: string
}

/**
 * Drive one fenced attempt. Streams `FencedEvent`s (stamped with `task.fence`),
 * suppresses emission after terminal/cancel (late-event drop, §6.4), and resolves
 * `outcome` only after confirmed process-tree exit (§6.5). The §6.5 ladder lives
 * in `cancel()`.
 */
export function startClaudeRun(task: AgentTask, deps: RunDeps): { run: AgentRun; cancel: () => Promise<void> } {
  // - An internal async queue bridges the query generator to `events`.
  // - `terminal` latch stops emission once a `result` arrives or cancel begins.
  // - On terminal `success`: poll processTree.activeProcesses() with deps.wait
  //   up to (confirmTimeoutMs ?? 5000); resolve completed{sessionId,finalText,usage}.
  // - SDK generator throw => .catch(e => new ClaudeSdkError({code:"STREAM_FAILED", cause:e}))
  //   => emit terminal {kind:"error"} + resolve backend-error{sessionId}.
  // - cancel(): abortController.abort(new TurnAbortError({})); latch terminal;
  //   wait<=5s for activeProcesses()===0; else processTree.terminate(); wait<=5s;
  //   re-read: 0 -> cancelled{exitConfirmed:true}; >0 -> unconfirmed-exit.
  // Full body per the pinned behavior above.
  return buildRun(task, deps, { TurnAbortError, normalizeMessage, deriveUsage, ClaudeSdkError })
}
```

> The executor writes the concrete queue/latch and the ladder. Constraints: `outcome` never rejects (errors are values); every `activeProcesses()`/`terminate()` result is checked `instanceof ProcessTreeError` and a persistent failure degrades to `unconfirmed-exit` (logged, not thrown); the events iterator returns cleanly after the terminal event.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/model/agent-run.test.ts && bun x tsc --noEmit`
Expected: PASS (all four cases: success stream, late-event drop, cancel-confirmed, cancel-unconfirmed).

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/agent-run.ts src/agent/model/agent-run.test.ts
rtk git commit -m "feat(agent-5): fenced run loop + late-event drop + §6.5 cancel ladder"
```

---

### Task 13: `agent/model/health.ts` — `healthCheck` probe + `capabilities` **[ordered: needs T11]**

**Files:**
- Create: `src/agent/model/health.ts`
- Test: `src/agent/model/health.test.ts`

**Interfaces:**
- Consumes: `ClaudeQueryFn`/`ClaudeQuery` (T11), `AgentInfo`/`AgentHealthState`/`BackendCapabilities` (T1), `AgentHealthProbeError` (T2). Imports SDK message types.
- Produces:
  - `probeHealth(queryFn, deps): Promise<AgentInfo>` — runs a minimal probe `query`, reads the stream; a `system:init` message → installed + reached CLI (→ `ready`, capturing an account discriminator from `apiKeySource`/init); an `auth_status`/assistant `error:'authentication_failed'`/auth result error → `not-logged-in`; a spawn/`ENOENT` throw → `not-installed`; then aborts without completing a paid turn.
  - `claudeCapabilities(): BackendCapabilities` — the static MVP capability table: models × efforts, `confinement:"canUseTool"`, `sessionWorkspaceBinding:"rebindable"` (see Q1).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeCapabilities, probeHealth } from "./health"
import type { ClaudeQuery } from "./query-fn"

function fake(messages: SDKMessage[], throwOnIterate?: Error): ClaudeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      if (throwOnIterate) throw throwOnIterate
      for (const m of messages) yield m
    },
    interrupt: async () => {},
  }
}

const init = { type: "system", subtype: "init", apiKeySource: "oauth", model: "claude-opus-4-8", session_id: "s", uuid: "u" } as unknown as SDKMessage

test("an init message means installed + logged in (ready)", async () => {
  const info = await probeHealth(() => fake([init]), { abortController: new AbortController() })
  expect(info.health.status).toBe("ready")
  expect(info.backendId).toBe("claude")
})

test("an authentication_failed signal means not-logged-in", async () => {
  const authErr = { type: "auth_status", isAuthenticating: false, error: "not logged in", session_id: "s", uuid: "u" } as unknown as SDKMessage
  const info = await probeHealth(() => fake([authErr]), { abortController: new AbortController() })
  expect(info.health.status).toBe("not-logged-in")
})

test("a spawn ENOENT throw means not-installed", async () => {
  const info = await probeHealth(() => fake([], new Error("spawn claude ENOENT")), { abortController: new AbortController() })
  expect(info.health.status).toBe("not-installed")
})

test("capabilities advertise canUseTool confinement and rebindable sessions", () => {
  const caps = claudeCapabilities()
  expect(caps.confinement).toBe("canUseTool")
  expect(caps.sessionWorkspaceBinding).toBe("rebindable")
  expect(caps.models.length).toBeGreaterThan(0)
  expect(caps.models[0]!.efforts).toContain("high")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/health.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/health.ts`**

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentInfo, BackendCapabilities } from "../types"
import type { ClaudeQuery } from "./query-fn"

const BACKEND_ID = "claude"

/** MVP model catalog (master §3.6 picker). Effort set mirrors the SDK EffortLevel. */
export function claudeCapabilities(): BackendCapabilities {
  return {
    backendId: BACKEND_ID,
    models: [
      { model: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { model: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
    confinement: "canUseTool",
    sessionWorkspaceBinding: "rebindable",
  }
}

/**
 * Probe installed/logged-in state (master §9) without completing a paid turn: run
 * a minimal query, read until `system:init` (installed, CLI reached) or an auth
 * signal (`auth_status`/`authentication_failed`), then abort. A spawn/ENOENT throw
 * is not-installed. Errors are values — the probe never throws.
 */
export async function probeHealth(
  queryFn: (params: { prompt: string; options: unknown }) => ClaudeQuery,
  deps: { abortController: AbortController; options?: unknown },
): Promise<AgentInfo> {
  const iterate = async (): Promise<AgentInfo> => {
    const q = queryFn({ prompt: "ping", options: deps.options ?? {} })
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
        const account = (msg as { apiKeySource?: string }).apiKeySource ?? null
        deps.abortController.abort()
        return { backendId: BACKEND_ID, health: { status: "ready" }, account }
      }
      if (msg.type === "auth_status") {
        deps.abortController.abort()
        return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
      }
      if (msg.type === "assistant" && (msg as { error?: string }).error === "authentication_failed") {
        deps.abortController.abort()
        return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
      }
    }
    return { backendId: BACKEND_ID, health: { status: "not-logged-in" }, account: null }
  }
  const result = await iterate().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (result instanceof Error) {
    const notInstalled = /ENOENT|not found|spawn/i.test(result.message)
    return {
      backendId: BACKEND_ID,
      health: { status: notInstalled ? "not-installed" : "not-logged-in" },
      account: null,
    }
  }
  return result
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/model/health.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/health.ts src/agent/model/health.test.ts
rtk git commit -m "feat(agent-5): healthCheck probe + static capabilities"
```

---

### Task 14: `agent/model/claude-backend.ts` — assemble the `AgentBackend` **[ordered: needs T9, T10, T12, T13]**

**Files:**
- Create: `src/agent/model/claude-backend.ts`
- Test: `src/agent/model/claude-backend.test.ts`

**Interfaces:**
- Consumes: `startClaudeRun` (T12), `probeHealth`/`claudeCapabilities` (T13), `deriveSessionScope` (T9), `buildQueryOptions` (T11), `AgentBackend`/`AgentTask`/`AgentRun` (T1), `ProcessTreeFactory` (T3).
- Produces: `createClaudeBackend(deps: ClaudeBackendDeps): AgentBackend`. Wires the five methods. `startTurn` builds options (with a fresh `AbortController` + a fresh `ProcessTree` from the injected factory) and returns the run; `cancel(run)` runs the ladder via the stored per-run cancel handle; `healthCheck` probes; `capabilities` is static; `sessionScope` derives.

Per-run state: `startTurn` records the run's `cancel` closure keyed by the `AgentRun` object (a `WeakMap<AgentRun, () => Promise<void>>`) so `backend.cancel(run)` finds it. A `ProcessTreeError` from the factory at `startTurn` degrades that run to an immediate `unhealthy-unconfirmed-exit`-style outcome (no tree to own → cannot guarantee confinement of the tree), surfaced as a `backend-error` event.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentTask } from "../types"
import { createClaudeBackend } from "./claude-backend"
import type { ClaudeQuery } from "./query-fn"
import { createFakeProcessTree } from "../../infrastructure/process/index"

const success = { type: "result", subtype: "success", result: "done", session_id: "s1", uuid: "u", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0, permission_denials: [] } as unknown as SDKMessage

function query(messages: SDKMessage[]): ClaudeQuery {
  return { async *[Symbol.asyncIterator]() { for (const m of messages) yield m }, interrupt: async () => {} }
}

const task: AgentTask = {
  fence: { turnId: "t", attempt: 0, leaseNonce: "n" },
  workspacePath: "C:\\ws",
  systemPrompt: "sys",
  userMessage: "hi",
  model: "claude-opus-4-8",
  effort: "high",
  session: { kind: "fresh", seed: [] },
}

test("startTurn runs an attempt and produces a completed outcome", async () => {
  const backend = createClaudeBackend({
    queryFn: () => query([success]),
    processTreeFactory: () => createFakeProcessTree({ counts: [0] }),
    wait: async () => {},
  })
  const run = backend.startTurn(task)
  for await (const _ of run.events) { /* drain */ }
  expect((await run.outcome).kind).toBe("completed")
})

test("sessionScope excludes effort", () => {
  const backend = createClaudeBackend({
    queryFn: () => query([success]),
    processTreeFactory: () => createFakeProcessTree({ counts: [0] }),
    wait: async () => {},
  })
  const a = backend.sessionScope({ account: "x", model: "claude-opus-4-8", workspaceIdentity: "w" })
  const b = backend.sessionScope({ account: "x", model: "claude-opus-4-8", workspaceIdentity: "w" })
  expect(a).toBe(b)
})

test("capabilities are the static Claude table", () => {
  const backend = createClaudeBackend({
    queryFn: () => query([success]),
    processTreeFactory: () => createFakeProcessTree({ counts: [0] }),
    wait: async () => {},
  })
  expect(backend.capabilities().backendId).toBe("claude")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/model/claude-backend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/model/claude-backend.ts`**

```ts
import type { AgentBackend, AgentRun, AgentTask, SessionScopeInput } from "../types"
import type { ProcessTreeFactory } from "../../infrastructure/process/index"
import { ProcessTreeError } from "../../infrastructure/process/index"
import type { ClaudeQueryFn } from "./query-fn"
import { buildQueryOptions } from "./query-fn"
import { startClaudeRun } from "./agent-run"
import { claudeCapabilities, probeHealth } from "./health"
import { deriveSessionScope } from "./session-scope"

const BACKEND_ID = "claude"

export interface ClaudeBackendDeps {
  readonly queryFn: ClaudeQueryFn
  readonly processTreeFactory: ProcessTreeFactory
  readonly wait: (ms: number) => Promise<void>
  readonly pathToClaudeCodeExecutable?: string
  readonly hasReparsePoint?: (p: string) => boolean
}

/** Construct the mechanism-blind Claude backend (master §6.1). */
export function createClaudeBackend(deps: ClaudeBackendDeps): AgentBackend {
  const cancels = new WeakMap<AgentRun, () => Promise<void>>()
  return {
    startTurn(task: AgentTask): AgentRun {
      const abortController = new AbortController()
      const tree = deps.processTreeFactory()
      if (tree instanceof ProcessTreeError) {
        // No owned tree -> cannot guarantee §6.5 exit confirmation. Fail the run
        // as backend-error rather than run unconfined.
        return degradedRun(task, tree.message)
      }
      const options = buildQueryOptions(task, {
        abortController,
        processTree: tree,
        pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
        hasReparsePoint: deps.hasReparsePoint,
      })
      const { run, cancel } = startClaudeRun(task, {
        queryFn: deps.queryFn,
        processTree: tree,
        abortController,
        wait: deps.wait,
        options,
        prompt: undefined, // buildPrompt(task) supplied inside startClaudeRun via options; see T12 note
      })
      cancels.set(run, cancel)
      return run
    },
    async cancel(run: AgentRun): Promise<void> {
      const c = cancels.get(run)
      if (c === undefined) return
      await c()
    },
    healthCheck() {
      return probeHealth(deps.queryFn, { abortController: new AbortController() })
    },
    capabilities() {
      return claudeCapabilities()
    },
    sessionScope(input: SessionScopeInput): string {
      return deriveSessionScope(BACKEND_ID, input)
    },
  }
}
```

> `degradedRun(task, message)` returns an `AgentRun` whose `events` yields one `{ fence: task.fence, event: { kind:"error", message } }` and whose `outcome` resolves `{ kind:"backend-error", message, sessionId:null }`. Add it as a small local helper. **Note for the executor:** reconcile `startClaudeRun`'s prompt/options seam with Task 12 — the cleanest is for `startClaudeRun` to accept the pre-built `options` and the pre-built `prompt` (from `buildPrompt(task)`) so `claude-backend` calls `buildPrompt` and `buildQueryOptions` and passes both in. Update the T12 `RunDeps` to take `prompt: string` + `options: unknown` as required fields, and have T12's tests pass `queryFn` a params object; keep the T12 tests green by supplying `prompt`/`options` there too.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test src/agent/model/claude-backend.test.ts && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/model/claude-backend.ts src/agent/model/claude-backend.test.ts
rtk git commit -m "feat(agent-5): assemble ClaudeBackend AgentBackend implementation"
```

---

### Task 15: `agent/index.ts` — public entry + production wiring **[ordered: needs T14]**

**Files:**
- Create: `src/agent/index.ts`
- Test: `src/agent/index.test.ts`

**Interfaces:**
- Produces: re-exports of the port types from `./types`; `createClaudeBackend` and `ClaudeBackendDeps`; `createProductionClaudeBackend()` — the zero-arg production factory that wires `createRealQueryFn()`, `createJobObjectTree` (as the `processTreeFactory`), `wait = (ms) => Bun.sleep(ms)`, and the Windows reparse backstop.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test"
import { createProductionClaudeBackend } from "./index"

test("the production backend exposes the five port methods and static capabilities", () => {
  const backend = createProductionClaudeBackend()
  expect(typeof backend.startTurn).toBe("function")
  expect(typeof backend.cancel).toBe("function")
  expect(typeof backend.healthCheck).toBe("function")
  expect(typeof backend.sessionScope).toBe("function")
  expect(backend.capabilities().backendId).toBe("claude")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/agent/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/agent/index.ts`**

```ts
// The Claude backend (master §6.1): the mechanism-blind AgentBackend over
// @anthropic-ai/claude-agent-sdk. NON-Reatom injected adapter — no atoms, no
// connect-hook lifetimes; the run/process lifetime is owned explicitly (hardening
// §3.8). Phase 6 lifts the port types in ./types into core/ports/ and injects the
// concrete backend from the composition root.
export type {
  AgentBackend,
  AgentTask,
  AgentRun,
  AgentRunOutcome,
  AgentInfo,
  AgentHealthState,
  BackendCapabilities,
  ModelCapability,
  ReasoningEffort,
  SessionWorkspaceBinding,
  SessionPlan,
  SeedRecord,
  SessionScopeInput,
  FencedEvent,
} from "./types"
export { createClaudeBackend } from "./model/claude-backend"
export type { ClaudeBackendDeps } from "./model/claude-backend"
export { createRealQueryFn } from "./model/query-fn"
export type { ClaudeQuery, ClaudeQueryFn } from "./model/query-fn"

import { createClaudeBackend } from "./model/claude-backend"
import { createRealQueryFn } from "./model/query-fn"
import { createJobObjectTree } from "../infrastructure/process/index"
import type { AgentBackend } from "./types"

/** Production wiring: real SDK query + real Job Object tree + real sleep. */
export function createProductionClaudeBackend(): AgentBackend {
  return createClaudeBackend({
    queryFn: createRealQueryFn(),
    processTreeFactory: createJobObjectTree,
    wait: (ms) => Bun.sleep(ms),
  })
}
```

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `bun test src/agent && bun x tsc --noEmit`
Expected: PASS across the whole `agent/` module.

- [ ] **Step 5: Commit**

```bash
rtk git add src/agent/index.ts src/agent/index.test.ts
rtk git commit -m "feat(agent-5): public entry + production ClaudeBackend wiring"
```

---

### Task 16: architecture-docs Source-anchor move **[ordered, last]**

**Files:**
- Modify: `docs/architecture/code-structure.md` (Source anchors + the `agent/` node), and any `docs/architecture/*` whose Source anchors point at spec §6.1 for `AgentBackend`.

**Interfaces:** none (docs only). Follow the `architecture:architecture-update` skill.

- [ ] **Step 1:** Load `architecture:architecture-update`; identify docs whose Source anchors reference the `AgentBackend` port or the `agent/` module.

- [ ] **Step 2:** Move anchors from `docs/superpowers/specs/2026-07-13-termcraft-design.md §6.1` to the real paths: `src/agent/types.ts` (port shapes), `src/agent/model/claude-backend.ts` (ClaudeBackend), `src/agent/model/normalize.ts` (event normalization), `src/infrastructure/process/` (process-tree ownership, Spike I). Note in code-structure §6 that the Job Object primitive is the newest domain-free infrastructure member (passes the "knows what a Page is" test).

- [ ] **Step 3:** Verify with the skill's check that every moved anchor resolves to an existing file.

- [ ] **Step 4: Run full gate**

Run: `bun test && bun x tsc --noEmit`
Expected: whole suite PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
rtk git add docs/architecture
rtk git commit -m "docs(agent-5): move AgentBackend + process-tree Source anchors to real paths"
```

---

## Deferred / cross-phase interfaces

Explicitly out of this plan — do not build here; consume/produce at the named phase:

- **`AgentTask` fields supplied by the kernel (phase 6):** the assembled `userMessage` (role, design-code rules §5.8, page order, source-extracted metadata, active page, outstanding diagnostics, selection, resolved-anchor pins, answer-style guidance, and the user's text — master §6.2), the `workspacePath` (staging populated by the kernel/store at send time), the `model`/`effort` from the picker triple, and the `session` decision (`resume` vs `fresh` + bounded seed). This phase only consumes the finished `AgentTask`.
- **Checkpoint persistence (phase 4 `store/`):** `(chatId, sessionScopeId) → { sessionId, recordCount, prefixHash }` in `workspace.local.toml`; `recordCount`/`prefixHash` computation; resume-eligibility comparison; bounded fresh-seed selection (≤32 / ≤64 KiB, drop oldest whole). This phase supplies the `sessionScopeId` and consumes the resulting `SessionPlan`; it never reads/writes chat JSONL.
- **Watchdog + absolute deadline (phase 6 `core/`):** the 120 s stream-silence watchdog (reset by any `AgentEvent`) and the non-resettable absolute turn deadline covering the initial attempt plus all retries are kernel-owned. The adapter only streams events (each item is the reset signal) and exposes `cancel(run)` for the kernel to fire on Esc / watchdog / deadline. No timer for these two lives in `agent/`.
- **Retry loop (phase 6 `core/`):** the ≤3 gate-retry loop, gate-error-to-conversation feedback, and CAS/apply pipeline. This phase runs one attempt per `startTurn` and confirms exit so the kernel can safely start the next.
- **Job-Object crash-path gap (Spike I, unresolved):** confirmed process-tree exit is a genuine OS read only for the application-driven cancel path. If the controller itself crashes (kill-on-close fires with no live handle), no read-based confirmation exists — MVP treats that as `backend_unhealthy_unconfirmed_exit`. A named-job reopen or a permanently-running supervisor holding an independent handle is a future spike, not built here.
- **Codex backend:** out of scope (v1.0, quota-blocked). No Codex code. `sandbox-degraded` health state exists in the port for forward-compat but Claude never returns it.

---

## Unresolved contract questions (flagged for the orchestrator)

1. **Claude `sessionWorkspaceBinding` = `rebindable` vs `fixed` (judgment call, biggest one).** Turn-durability §6.3 permits cross-turn SDK resume only when the backend reports `rebindable` **and proves the resumed run uses the new cwd/writable root**. This plan reports `rebindable` on the reasoning that each attempt sets `cwd`, `additionalDirectories:[]`, and a `canUseTool` bound to the *new* staging root, so confinement + writable root are re-established per attempt regardless of what history the resume replays (Spike H proved the callback intercepts every tool). The residual risk: a resumed conversation references the previous turn's workspace paths; those reads are denied (defense-in-depth) and the model must adapt. If the orchestrator judges that risk unacceptable for MVP, the conservative alternative is `sessionWorkspaceBinding: "fixed"` — resume only for same-turn-workspace retries, always fresh-seed across turns. Both are one-line changes in `claudeCapabilities()`. **Recommendation:** ship `rebindable` (matches the spec's preference) but note the caveat; revisit if resume produces stale-path churn.

2. **healthCheck without spending tokens (minor).** No SDK export reports auth/install without a query. This plan runs a probe `query` and aborts at the first `system:init` (before any model turn), classifying installed/logged-in from init/auth signals. This should not incur a paid completion, but the exact "reached init then aborted" cost is unverified against a live account (Spike H only ran full turns). If a cheaper path is required, `Query.initializationResult()` in streaming-input mode is an alternative but needs an `AsyncIterable<SDKUserMessage>` prompt — more machinery. **Recommendation:** ship the abort-at-init probe; verify token cost in the phase-8 live walkthrough.

3. **`prompt`/`options` seam between Task 12 and Task 14 (mechanical).** Task 12's `startClaudeRun` needs the built `prompt` (from `buildPrompt(task)`) and `options` (from `buildQueryOptions`). The plan has Task 14 build both and pass them in as required `RunDeps` fields; Task 12's tests must then also supply them. This is called out in Task 14's executor note — reconcile the two signatures during Task 12 (make `prompt: string` and `options: Options` required on `RunDeps`, and have the T12 fake `queryFn` ignore them). No design impact; flagged so the executor does not leave a loose seam.

4. **`ChildProcess`-as-`SpawnedProcess` under Bun (low risk).** The SDK's `spawnClaudeCodeProcess` expects a `SpawnedProcess` that Node's `ChildProcess` satisfies; this plan spawns via `node:child_process.spawn`. Bun implements `node:child_process`, and Spike H confirmed the SDK spawns/streams its CLI correctly under Bun (both `bun run` and compiled). The `.pid` availability for `adopt` is the only new dependency vs. the spike; `node:child_process.spawn` exposes `.pid` synchronously. **Recommendation:** verify the `adopt(pid)` timing (Spike I's assign-before-descendant race is empirical headroom, not guaranteed) with a re-read of `activeProcesses()` after adopt, as the plan already specifies.

---

## Self-review

- **Spec coverage:** master §6.1 backend abstraction (T1 port, T14 assembly), confinement (T5/T6, Spike H), `AgentEvent` normalization (T7/T8) — covered. §6.2 turn protocol/workspace/fencing (T1 `AgentTask`/`FencedEvent`, T12 fencing + late-event drop), sessions (T9/T10, boundary stated) — covered. §9 healthCheck states (T13), cancel/confirmed-exit (T12, §6.5 ladder), watchdog kernel-owned (deferred) — covered. turn-durability §6.3–6.5 (T9/T10/T12, `SessionWorkspaceBinding`, cancel ladder) — covered. Spike H `canUseTool` (T6, all 5 attack cases tested) and Spike I Job Object + confirmation + crash-gap (T4, T12 unconfirmed-exit) — covered. Test-strategy master §10 `agent` line (normalization, resume/fresh, confinement, fencing, confirmed cancel) — each has a task with SCRIPTED-SDK-FAKE tests.
- **Placeholder scan:** no "TBD"/"add error handling" placeholders; every code step shows real code or (for the two large bodies, T4 FFI and T12 run loop) a precisely-pinned skeleton plus the exact behavior contract and the proven spike source to copy — these are the two files where inlining 150 lines verbatim would duplicate `docs/spikes/09-process-tree/src/main.ts`; the behavior and every test are concrete.
- **Type consistency:** `AgentBackend`/`AgentTask`/`AgentRun`/`AgentRunOutcome`/`FencedEvent`/`SessionPlan`/`SessionScopeInput`/`ReasoningEffort` defined once in T1 and used verbatim downstream; `ProcessTree`/`ProcessTreeFactory`/`ProcessTreeError` from T3; `ClaudeQuery`/`ClaudeQueryFn`/`buildQueryOptions` from T11; `startClaudeRun` from T12; `probeHealth`/`claudeCapabilities` from T13; `createClaudeBackend`/`ClaudeBackendDeps` from T14. The one seam that spans tasks (T12↔T14 prompt/options) is flagged in Q3 with the fix.
- **errore/Reatom:** errore boundaries are exactly the SDK stream/abort (T12/T13 `.catch`→`ClaudeSdkError`) and the FFI (T4 `errore.try`→`ProcessTreeError`); everything above returns values (`AgentRunOutcome`, `AgentInfo`, `PermissionResultLike`). Non-Reatom stated in the module header and `index.ts` comment.

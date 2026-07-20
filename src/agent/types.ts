import type { AgentEvent, TokenUsage, TurnFence } from "entities/turn"

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

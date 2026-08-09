// The mechanism-blind AgentBackend port (master §6.1) plus the production
// backend. Phase 6 lifts the port types in ./types into core/ports/ and
// injects the concrete backend from the composition root.
//
// Vendor-scoped construction detail (createClaudeBackend, ClaudeBackendDeps,
// the raw SDK query seam) lives under `agent/claude` — a future Codex backend
// gets its own sibling module there, and this file stays vendor-neutral: the
// port, and "the" production backend, nothing more (see docs/architecture
// and the phase-5 handoff for the shared-vs-vendor split rationale).
export type {
  AgentBackend,
  AgentTask,
  AgentRun,
  AgentRunOutcome,
  AgentInfo,
  AgentHealthState,
  BackendCapabilities,
  BackendErrorCause,
  ModelCapability,
  ReasoningEffort,
  SessionWorkspaceBinding,
  SessionPlan,
  SeedRecord,
  SessionScopeInput,
  FencedEvent,
} from "./types";
export { createProductionClaudeBackend } from "./claude";
// M18: the one-entry production `AgentRegistry` over the backend above (WP-2
// Task 7 — see `agent/adapters/agent-registry.ts` for the mapping notes).
export { createProductionAgentRegistry } from "./adapters/agent-registry";
// phase-8 WP-3: the agent-prompt library — implements `core/ports/agent-prompt.ts`'s
// `AgentPromptSource` (system prompt composition + runtime-doc file paths).
export { createProductionAgentPromptSource } from "./prompt";

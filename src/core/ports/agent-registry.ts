import type { AgentBackend, BackendCapabilities } from "./agent-backend";

/**
 * The registry `core` consumes instead of a single `AgentBackend` (code-structure §8):
 * "the stored `(agent, model, effort)` triple is domain state the Kernel owns. So `core`
 * consumes a registry — enumerate the available backends, take one by id — rather than a
 * single `AgentBackend`; `main.ts` supplies the registry with the backends the build
 * knows about, and `core` selects from it." `model.select` (kernel-command-contract §8.2:
 * "Validate backend capability and store the machine-local selection") is the one MVP
 * command that reads this port — it needs the full capability catalog to validate a
 * requested `(backend, model, effort)` triple, then `get` to hand the turn machine the
 * chosen backend. The other half of `model.select` — persisting the validated triple — is
 * one of blocker B3's six store-side gaps; see `project-store.ts`'s `writeWorkspaceState`.
 * `model.select` is a two-port command precisely because "validate" and "persist" are two
 * different modules' concerns.
 *
 * MVP ships exactly one entry (`agent/index.ts`'s `createProductionClaudeBackend`); the
 * registry shape is written for the general case anyway because code-structure §8 states
 * "today's single production factory stands in for the one-entry case" — the port, not the
 * cardinality, is what phase 6 fixes.
 */
export interface AgentRegistry {
  /** Every backend's static capabilities — the picker's full models × efforts catalog. */
  list(): readonly BackendCapabilities[];
  /** `null` for an id no registered backend reports — `model.select`'s `AGENT_UNAVAILABLE`-shaped rejection path, never a thrown lookup error. */
  get(backendId: string): AgentBackend | null;
}

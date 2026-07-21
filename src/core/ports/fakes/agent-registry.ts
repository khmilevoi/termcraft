import type { AssertConforms } from "../index"
import type { AgentBackend, BackendCapabilities } from "../agent-backend"
import type { AgentRegistry } from "../agent-registry"

/**
 * In-memory {@link AgentRegistry} fake (6D task brief). Backed by whatever
 * {@link AgentBackend}s the test constructs it with — usually {@link createFakeAgentBackend}
 * instances from `./agent-backend.ts` — keyed by each backend's own
 * `capabilities().backendId`, mirroring how `model.select` validates against the full
 * catalog before calling `get` to hand the turn machine the chosen backend.
 */

export type AgentRegistryCall =
  | { readonly method: "list" }
  | { readonly method: "get"; readonly backendId: string; readonly found: boolean }

export interface FakeAgentRegistry extends AgentRegistry {
  readonly calls: readonly AgentRegistryCall[]
}

export function createFakeAgentRegistry(backends: readonly AgentBackend[]): FakeAgentRegistry {
  const byId = new Map<string, AgentBackend>(backends.map((backend) => [backend.capabilities().backendId, backend]))
  const calls: AgentRegistryCall[] = []

  function list(): readonly BackendCapabilities[] {
    calls.push({ method: "list" })
    return [...byId.values()].map((backend) => backend.capabilities())
  }

  function get(backendId: string): AgentBackend | null {
    const backend = byId.get(backendId) ?? null
    calls.push({ method: "get", backendId, found: backend !== null })
    return backend
  }

  return { list, get, calls }
}

type _Conforms = AssertConforms<AgentRegistry, FakeAgentRegistry>

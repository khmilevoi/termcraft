// M18 (WP-2 Task 7): the one-entry production `AgentRegistry` over
// `createProductionClaudeBackend` (`agent/index.ts:26`). `core/ports/agent-registry.ts`'s
// own header states MVP ships exactly one entry and "the port, not the cardinality, is
// what phase 6 fixes" — this factory is that one entry, keyed by the backend's own
// `capabilities().backendId` (the SAME id `deriveSessionScope`/`AgentInfo` report),
// mirroring how `core/ports/fakes/agent-registry.ts` keys its in-memory double. `list()`
// and `get()` both read `backend.capabilities()` honestly on every call — never a cached
// or invented label — so a future capability change (a new model added to the catalog)
// is reflected without this file needing to change.
import type { DesignCheckerPort } from "agent/checks";
import { createProductionClaudeBackend } from "agent/claude";
import type { AgentBackend, AgentRegistry, AssertConforms, BackendCapabilities } from "core/ports";

/**
 * `designChecker` is threaded straight through to the one backend this registry holds (spec
 * WP-10) — required, never defaulted: it is `gate`-backed, and only the composition root can see
 * both `agent` and `gate`. See `agent/claude/index.ts`'s `createProductionClaudeBackend`.
 */
export function createProductionAgentRegistry(designChecker: DesignCheckerPort): AgentRegistry {
  const backend = createProductionClaudeBackend(designChecker);

  function list(): readonly BackendCapabilities[] {
    return [backend.capabilities()];
  }

  function get(backendId: string): AgentBackend | null {
    return backend.capabilities().backendId === backendId ? backend : null;
  }

  return { list, get };
}

type _Conforms = AssertConforms<AgentRegistry, ReturnType<typeof createProductionAgentRegistry>>;

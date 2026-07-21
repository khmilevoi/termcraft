/**
 * The single source for the Claude backend's identifier. Used both as the
 * `backendId` reported on `AgentInfo`/`BackendCapabilities` (health/model/probe.ts,
 * claude/backend/model/backend.ts) AND as the `backendId` material fed into
 * `deriveSessionScope` (session/model/session-scope.ts) for the store
 * checkpoint key namespace.
 *
 * Defined once and imported everywhere it is needed, so a second backend
 * (Codex) added later cannot desynchronise the session-scope key namespace
 * from the reported backendId by only updating one of the two call sites.
 */
export const CLAUDE_BACKEND_ID = "claude"

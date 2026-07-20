/**
 * The single source for the Claude backend's identifier. Used both as the
 * `backendId` reported on `AgentInfo`/`BackendCapabilities` (health.ts,
 * claude-backend.ts) AND as the `backendId` material fed into
 * `deriveSessionScope` (agent/model/session-scope.ts) for the store
 * checkpoint key namespace.
 *
 * Previously duplicated as a private `const BACKEND_ID = "claude"` in both
 * health.ts and claude-backend.ts with no shared source — a review finding
 * noted that copy-adapting one of those files for a second backend (Codex)
 * could silently desynchronise the session-scope key namespace from the
 * reported backendId if only one copy got updated. Defining it once here and
 * importing it in both closes that gap.
 */
export const CLAUDE_BACKEND_ID = "claude"

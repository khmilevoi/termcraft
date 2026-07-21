export { createClaudeBackend } from "./model/backend";
// `CLAUDE_BACKEND_ID`/`claudeCapabilities` stay exported: `agent/claude/index.test.ts`
// reaches them via a relative `./backend` import to assert the production
// backend's `capabilities()`/`backendId` against these same source-of-truth
// values, not stubs.
export { claudeCapabilities } from "./model/capabilities";
export { CLAUDE_BACKEND_ID } from "./model/backend-id";

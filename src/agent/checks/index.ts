// The design SELF-CHECK the agent runs on its own turn workspace mid-attempt (spec WP-10).
// Vendor-neutral by construction: the port it consumes, the renderer, and the one function a
// backend's tool handler calls. The SDK-shaped tool declaration that wraps it lives in the
// vendor tier (`agent/claude/tools/model/check-design-tool.ts`), because `createSdkMcpServer`
// and `tool()` are Claude Agent SDK surface and none of `agent`'s shared folders import a
// vendor SDK (docs/architecture/code-structure.md item 1).
export type {
  DesignCheckErrorV1,
  DesignCheckInputV1,
  DesignCheckReportV1,
  DesignCheckWarningV1,
  DesignCheckerPort,
} from "./types";
export {
  DESIGN_CHECK_CLEAN_HEADLINE,
  renderDesignCheckFailure,
  renderDesignCheckReport,
} from "./model/render";
export { runDesignCheck } from "./model/run-check";

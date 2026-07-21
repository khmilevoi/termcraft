import type { BackendCapabilities } from "agent/types";

import { CLAUDE_BACKEND_ID } from "./backend-id";

/** MVP model catalog (master §9 picker). Effort set mirrors the SDK `EffortLevel`. */
export function claudeCapabilities(): BackendCapabilities {
  return {
    backendId: CLAUDE_BACKEND_ID,
    models: [
      { model: "claude-opus-4-8", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { model: "claude-sonnet-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
    confinement: "canUseTool",
    // Q1 (settled for MVP): a resumed vendor session may rebind to a NEW turn
    // workspace between attempts (cwd changes, the vendor session id stays put).
    // The conservative alternative — "fixed", forcing a fresh session whenever
    // the workspace changes — is a one-line change here if rebinding is ever
    // found to leak state across turn workspaces.
    sessionWorkspaceBinding: "rebindable",
  };
}

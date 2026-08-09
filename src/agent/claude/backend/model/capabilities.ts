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
    // MEASURED FALSE, 2026-08-09 — corrected from "rebindable". The comment this replaces
    // called "fixed" a one-line change "if rebinding is ever found to leak state across turn
    // workspaces". What was found is stronger: rebinding does not work at all. The SDK indexes
    // sessions by cwd, every turn gets a create-new `turns/<turnId>/workspace`
    // (`store/sandbox/model/staging-store.ts`), and a resume of a previous turn's session from
    // the new cwd failed with `No conversation found with session ID: 28b861a5`. An advertised
    // capability contradicted by a production failure is the worse of the two states.
    //
    // THIS FLAG HAS NO PRODUCTION READER TODAY, and flipping it therefore changes NO behaviour.
    // Every reference is this value, its type (`agent/types.ts`), the lifted port
    // (`core/ports/agent-backend.ts`), one assertion and eight test fixtures. The behavioural
    // half of this correction is the classified resume rejection and the fallback below — not
    // this line. Do not read the flip as the fix.
    //
    // The turn-durability §6.3 probe that was supposed to establish this value empirically is
    // still unwritten; it is ledgered, and it would now have to prove the value WRONG to change
    // it back.
    sessionWorkspaceBinding: "fixed",
    // MVP has no `/model` picker, so the Kernel falls back to this when a turn
    // starts with no stored (backend, model, effort) triple (see turn.ts).
    defaultSelection: { model: "claude-sonnet-5", effort: "high" },
  };
}

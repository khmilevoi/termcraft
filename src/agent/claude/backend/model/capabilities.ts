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
    // (`core/ports/agent-backend.ts`), one assertion, the shared fake's own default
    // (`core/ports/fakes/agent-backend.ts`) and ten test fixtures (recounted at the plan's
    // closeout; this line said "eight" and was already stale by then). The behavioural half of
    // this correction is the classified resume rejection and the fallback below — not this
    // line. Do not read the flip as the fix.
    //
    // CORRECTED 2026-08-10, design-agent-feedback-loop closeout (Task 13). This paragraph read:
    // "The turn-durability §6.3 probe that was supposed to establish this value empirically is
    // still unwritten; it is ledgered, and it would now have to prove the value WRONG to change
    // it back." The first clause was FALSE when it was written. §6.3 asks a backend to "prove
    // that the resumed run uses the new cwd and writable root"; spike 12
    // (`docs/spikes/12-resume-rejection/SPIKE.md`) ran exactly that experiment, deliberately and
    // with a positive control — observation B minted a real session id in cwd X, C resumed it
    // from X and SUCCEEDED (proving the id itself was live and resumable), D resumed the same id
    // from a DIFFERENT cwd and was REJECTED. The rejection is therefore attributable to the cwd
    // and not to a stale id, which is the whole thing a probe has to establish. So the probe is
    // RUN and this value is set from an experiment, not from an assumption. What survives from
    // the old wording is its second half: a future probe would now have to prove the value WRONG
    // to change it back, and `docs/superpowers/red-debt.md` records the exact bar it must clear
    // (a session resumed from a different cwd, with positive proof it really resumed, against
    // the SDK version installed at that time).
    sessionWorkspaceBinding: "fixed",
    // MVP has no `/model` picker, so the Kernel falls back to this when a turn
    // starts with no stored (backend, model, effort) triple (see turn.ts).
    defaultSelection: { model: "claude-sonnet-5", effort: "high" },
  };
}

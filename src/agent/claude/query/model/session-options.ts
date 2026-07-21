import type { SessionPlan } from "agent/types";

/** SDK session options for a plan. `forkSession:false` keeps the resumed session id stable. */
export function planToSessionOptions(plan: SessionPlan): { resume?: string; forkSession: false } {
  if (plan.kind === "resume") return { resume: plan.sessionId, forkSession: false };
  return { forkSession: false };
}

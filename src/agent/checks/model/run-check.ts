import { trace } from "infrastructure/debug-log";

import type { DesignCheckerPort } from "../types";
import { renderDesignCheckFailure, renderDesignCheckReport } from "./render";

/**
 * ONE self-check, rendered. The whole body of `check_design`'s handler, kept out of the vendor
 * tier so the SDK-shaped tool declaration (`agent/claude/tools/model/check-design-tool.ts`) is
 * nothing but the SDK shape — a future Codex backend reuses this function unchanged, which is
 * the same shared-vs-vendor split `agent/confinement`, `agent/session`, `agent/health` and
 * `agent/run` already follow.
 *
 * CALLS THE PORT ON EVERY INVOCATION, and memoizes NOTHING. That is not an omission to optimize
 * later: the tool exists so the agent can edit, check, and edit again inside one attempt, and a
 * cached answer would report the code the agent already fixed. `workspacePath` is captured from
 * the `AgentTask` when the tool is built (there is no path in the tool's input schema — C9), so
 * what varies between two calls is the CONTENT of that workspace, which is exactly what has to
 * be re-read.
 *
 * Errors are values, never thrown past this boundary: a port that could not run at all renders
 * as a loud failure rather than an empty — and therefore clean-looking — report.
 */
export async function runDesignCheck(
  checker: DesignCheckerPort,
  workspacePath: string,
): Promise<string> {
  const report = await checker.check({ workspacePath });
  if (report instanceof Error) {
    // DIAGNOSTIC (infrastructure/debug-log): the self-check could not run at all. Traced because
    // the agent is told "the check was unavailable" and finishes anyway -- without this the only
    // record of WHY would be inside a turn transcript nobody reads back.
    trace("agent.checks.designCheck.unavailable", {
      workspacePath,
      reason: report.message,
    });
    return renderDesignCheckFailure(report);
  }
  // DIAGNOSTIC (infrastructure/debug-log): one mid-attempt self-check and what it found -- the
  // measurement this whole capability is justified by (did the agent call it, and did calling it
  // let the turn finish inside one attempt) is not answerable from the turn's events alone.
  trace("agent.checks.designCheck.ran", {
    workspacePath,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
  });
  return renderDesignCheckReport(report);
}

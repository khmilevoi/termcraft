import type { AgentHealth } from "ui/agent-health";
import type { StatusBarHintBadge } from "ui/status-bar";

/**
 * The agent-health reading as the Workspace status bar's `hint` badge (design
 * `design/30-workspace-first-launch.dc.html`'s "The badge vocabulary", engine `agentBadge`
 * `design/termcraft-engine.js:208-218`).
 *
 * Five outcomes, four shapes. `ready` draws NOTHING, matching Home. `checking` and `advisory`
 * read amberHi on `line`; `blocked` and `missing` read `bg` on `red`. `missing` has no badge on
 * Home at all — it takes over the whole screen there — and §30 invents its Workspace shape from
 * the takeover's own words, because hiding a working project behind a problem that blocks one
 * capability out of six is wrong.
 *
 * DIVERGENCE (design sample data, not layout): the design writes `codex` (user decision
 * 2026-07-23). The agent name comes from the reading itself.
 *
 * DIVERGENCE (inherited): `StatusBarHintBadge` is plain text and cannot host a component
 * (`ui/home/ui/Home.tsx:56` already documents this), so the `⠹` is static, not animated. Home
 * lives with it; so does this.
 *
 * `short` is the design's own `opt.short` — at the 80-column floor the agent name is dropped
 * (`⠹ checking`, not `⠹ checking codex`), the same restraint the idle shell already applies.
 * The two advisory phrases never carried the name, so `short` cannot change them.
 */
export function agentHealthBadge(health: AgentHealth, short: boolean): StatusBarHintBadge | null {
  if (health.kind === "ready") return null;
  if (health.kind === "checking") {
    return {
      text: short ? "⠹ checking" : `⠹ checking ${health.agent}`,
      fg: "amberHi",
      bg: "line",
    };
  }
  if (health.kind === "advisory") {
    return {
      text: health.panel === "sandbox" ? "⚠ sandbox degraded" : "⚠ health unconfirmed",
      fg: "amberHi",
      bg: "line",
    };
  }
  if (health.kind === "blocked") {
    const text =
      health.panel === "latched"
        ? short
          ? "✗ unavailable"
          : `✗ ${health.agent} unavailable`
        : short
          ? "✗ not signed in"
          : `✗ ${health.agent} not signed in`;
    return { text, fg: "bg", bg: "red" };
  }
  return {
    text: short ? "✗ not found" : `✗ ${health.agent} not found`,
    fg: "bg",
    bg: "red",
  };
}

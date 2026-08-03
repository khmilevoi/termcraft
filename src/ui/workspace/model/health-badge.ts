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
// A `switch` with no `default`, not the `if`-chain's bare final `return` — the same compile-time
// exhaustiveness idiom `src/entities/turn/types.test.ts`'s `describeEvent` already uses. The
// explicit `StatusBarHintBadge | null` return type means a sixth `AgentHealth` variant added
// later leaves this function without a return path for it, which `tsc` rejects at compile time
// ("Function lacks ending return statement…") — never a silent, alarming `✗ … not found` badge
// rendered for a case nobody wrote a branch for.
export function agentHealthBadge(health: AgentHealth, short: boolean): StatusBarHintBadge | null {
  switch (health.kind) {
    case "ready":
      return null;
    case "checking":
      return {
        text: short ? "⠹ checking" : `⠹ checking ${health.agent}`,
        fg: "amberHi",
        bg: "line",
      };
    case "advisory":
      return {
        text: health.panel === "sandbox" ? "⚠ sandbox degraded" : "⚠ health unconfirmed",
        fg: "amberHi",
        bg: "line",
      };
    case "blocked": {
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
    case "missing":
      return {
        text: short ? "✗ not found" : `✗ ${health.agent} not found`,
        fg: "bg",
        bg: "red",
      };
  }
}

/** The halted-preview panel's dead-agent correction — see {@link agentDeadNotice}. */
export interface AgentDeadNotice {
  /**
   * The F6 row's second line, when the design supplies one for this reading. `null` keeps the
   * panel's ordinary wording — see the divergence note on {@link agentDeadNotice}.
   */
  readonly f6Detail: string | null;
  /** The red line under the tee rule (design 30, "The collision"). */
  readonly line: string;
}

/**
 * The correction the halted-preview panel needs when the agent probe has separately read the
 * agent as unusable (design `design/30-workspace-first-launch.dc.html`'s "The collision", engine
 * `wsHostCrash`'s `agentDead` branch, `design/termcraft-engine.js:1198-1240`).
 *
 * A crashed preview's own repair path is F6 → a turn → the agent. With the agent dead that turn
 * cannot run, so the block's `repair…` route promises something it cannot deliver — and the
 * composer would quietly swallow an ⏎ that goes nowhere. The hint slot is NOT the place to say
 * so: the halt's own `render crashed` badge keeps it, being the more urgent and more specific
 * fact, and the panel carries the correction instead.
 *
 * `null` for `ready`, `checking` and `advisory`: only a positively-established "cannot run"
 * reading justifies contradicting the panel's own repair route.
 *
 * DIVERGENCE (the design draws one reading): §30's frame is `blocked` + `login`, and its F6 line
 * — `codex is not signed in — nothing runs until it is` — does not generalise to `latched` or
 * `missing`. Those two keep the panel's ordinary F6 wording (which is still TRUE: F6 does not
 * send) and rely on {@link AgentDeadNotice.line}, which composes from the badge phrase the design
 * itself authored plus §30's own tail, so nothing is invented.
 */
export function agentDeadNotice(health: AgentHealth): AgentDeadNotice | null {
  if (health.kind !== "blocked" && health.kind !== "missing") return null;
  // Built FROM the badge so the panel line and the badge can never disagree about how this
  // reading is named.
  const badge = agentHealthBadge(health, false);
  if (badge === null) return null; // unreachable: neither kind above maps to a null badge
  const line = `${badge.text} — F6 fills the composer, but nothing runs yet`;
  if (health.kind === "blocked" && health.panel === "login") {
    return { f6Detail: `${health.agent} is not signed in — nothing runs until it is`, line };
  }
  return { f6Detail: null, line };
}

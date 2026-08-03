import type { StatusBarHintBadge } from "ui/status-bar";

import type { AgentHealth } from "../types";

/**
 * The status-bar `hint` badge for one health reading — design
 * `design/30-workspace-first-launch.dc.html` §"The badge vocabulary" and the engine's own
 * `agentBadge` (`design/termcraft-engine.js:208-218`).
 *
 * Five outcomes, four shapes: `ready` draws nothing, matching Home. `checking`/`advisory` read
 * amber-on-line; `blocked`/`missing` read bg-on-red. `missing` has no badge on Home at all (it
 * takes over the whole screen there) — this shape is the design's own, invented from that
 * takeover's words.
 *
 * `options.short` is the design's `opt.short`, applied below 100 columns (`wsOpening`'s own
 * `narrow` constant, `:235`): the agent name is dropped, nothing else changes.
 *
 * DIVERGENCE (design sample data, not layout): the engine hardcodes `codex` throughout. MVP ships
 * Claude only, so the name comes from the reading itself — the same substitution `Home.tsx`'s own
 * `homeStatusBadge` already makes.
 *
 * DIVERGENCE (`latched`): Home renders `✗ {agent} locked out` for this cause — its own wording,
 * invented before any design covered the state. Design 30 now names the WORKSPACE shape,
 * `codex unavailable`, so this follows the design and Home keeps its own line.
 *
 * The two screens disagree on wording for TWO causes, not one: `latched` above, and `checking`
 * — Home's own `⠹ checking {agent} — ⏎ disabled` carries a submit-disabled tail this badge does
 * not, since only Home's Enter is gated on health (`ui/home/types.ts`'s own `homeSubmitAllowed`
 * doc comment; the Workspace composer is explicitly not). Both are deliberate, not drift; the
 * design is the reason for `latched`, Home's own submit-gating is the reason for `checking`.
 */
export function agentHealthBadge(
  health: AgentHealth,
  options: { readonly short: boolean },
): StatusBarHintBadge | null {
  if (health.kind === "ready") return null;
  // `checking` is the one shape that puts the name AFTER the verb (`⠹ checking codex`).
  if (health.kind === "checking") {
    return {
      text: options.short ? "⠹ checking" : `⠹ checking ${health.agent}`,
      fg: "amberHi",
      bg: "line",
    };
  }
  if (health.kind === "advisory") {
    // The engine's own `:215`: `detail==='sandbox' ? 'sandbox degraded' : 'health unconfirmed'`.
    // Neither carries the agent name, so `short` changes nothing here.
    return {
      text: health.panel === "sandbox" ? "⚠ sandbox degraded" : "⚠ health unconfirmed",
      fg: "amberHi",
      bg: "line",
    };
  }
  const name = options.short ? "" : `${health.agent} `;
  if (health.kind === "blocked") {
    return {
      text: health.panel === "latched" ? `✗ ${name}unavailable` : `✗ ${name}not signed in`,
      fg: "bg",
      bg: "red",
    };
  }
  return { text: `✗ ${name}not found`, fg: "bg", bg: "red" };
}

/**
 * The two lines a halted preview adds when the agent separately cannot run the repair turn its
 * `F6` route promises — design 30 §"The collision", engine `wsHostCrash`'s `o.agentDead` branch
 * (`:1227-1228`). `null` whenever a turn could still run: the halt block is then exactly as the
 * design already drew it.
 *
 * `line` is the badge's own text plus the design's literal tail, so the panel and the status bar
 * can never state the fact two different ways. `f6Detail` replaces the F6 row's second line
 * (`nothing is sent — you press ⏎`), which is untrue while the agent is dead.
 *
 * DIVERGENCE: the design mocks only the `blocked/login` cause, whose two lines this reproduces
 * verbatim (agent name substituted). `latched` and `missing` keep the identical sentence shape,
 * with each cause's wording taken from its OWN design-anchored badge above rather than invented.
 */
export function agentBlockedNote(
  health: AgentHealth,
): { readonly line: string; readonly f6Detail: string } | null {
  if (health.kind !== "blocked" && health.kind !== "missing") return null;
  const badge = agentHealthBadge(health, { short: false });
  if (badge === null) return null; // unreachable: both kinds above always produce a badge
  const cause =
    health.kind === "missing"
      ? "is not installed"
      : health.panel === "latched"
        ? "is unavailable"
        : "is not signed in";
  return {
    line: `${badge.text} — F6 fills the composer, but nothing runs yet`,
    f6Detail: `${health.agent} ${cause} — nothing runs until it is`,
  };
}

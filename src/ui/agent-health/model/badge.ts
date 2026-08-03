import type { StatusBarHintBadge } from "ui/status-bar";

import type { AgentHealth } from "../types";

/**
 * Per-screen wording for the two documented divergences between {@link agentHealthBadge} (this
 * module, the Workspace status bar / `agentBlockedNote`) and `Home.tsx`'s own `homeStatusBadge`
 * — see {@link buildAgentHealthBadge}'s doc comment for what each one is and why it exists.
 */
export interface AgentHealthBadgeWording {
  /** Appended to the `checking` text, after the (short-aware) agent name/short form. "" for
   * `agentHealthBadge`; Home's own `" — ⏎ disabled"` names its Enter-key gating. */
  readonly checkingSuffix: string;
  /** The `blocked/latched` line, given the short-aware name prefix (`"{agent} "` or `""`, the
   * same `name` local this builder already computes for `blocked/login` and `missing`). */
  readonly latchedText: (name: string) => string;
}

/**
 * The shared five-branch skeleton behind BOTH `agentHealthBadge` below (the Workspace status bar
 * and `agentBlockedNote`) and `Home.tsx`'s own `homeStatusBadge` — design
 * `design/30-workspace-first-launch.dc.html` §"The badge vocabulary" and the engine's own
 * `agentBadge` (`design/termcraft-engine.js:208-218`).
 *
 * Five outcomes, four shapes: `ready` draws nothing, matching Home. `checking`/`advisory` read
 * amber-on-line; `blocked`/`missing` read bg-on-red. `missing` has no badge on Home at all (it
 * takes over the whole screen there) — this shape is the design's own, invented from that
 * takeover's words; Home's own wrapper guards `missing` explicitly rather than relying on this
 * builder to never be asked, since the Workspace status bar DOES ask for it honestly.
 *
 * `options.short` is the design's `opt.short`, applied below 100 columns (`wsOpening`'s own
 * `narrow` constant, `:235`): the agent name is dropped, nothing else changes. Home never passes
 * `short: true` (its layout never needs it), so `wording`'s two fields never interact with the
 * narrow form in practice, but both stay short-aware for the one caller that does.
 *
 * DIVERGENCE (design sample data, not layout): the engine hardcodes `codex` throughout. MVP ships
 * Claude only, so the name comes from the reading itself — the same substitution `Home.tsx`'s own
 * `homeStatusBadge` already makes.
 *
 * The two screens disagree on wording for exactly TWO causes — both captured by `wording`, never
 * by branching here:
 * - `checking`: Home's own `⠹ checking {agent} — ⏎ disabled` carries a submit-disabled tail
 *   `agentHealthBadge` does not, since only Home's Enter is gated on health (`ui/home/types.ts`'s
 *   own `homeSubmitAllowed` doc comment; the Workspace composer is explicitly not).
 * - `blocked` + `panel === "latched"`: Home renders `✗ {agent} locked out` — its own wording,
 *   invented before any design covered the state. Design 30 now names the WORKSPACE shape,
 *   `{agent} unavailable`, so `agentHealthBadge` follows the design and Home keeps its own line.
 *
 * Both are deliberate, not drift; the design is the reason for `latched`, Home's own submit-
 * gating is the reason for `checking`. Everything else — `blocked/login` → `"not signed in"`,
 * `advisory` → `"sandbox degraded"`/`"health unconfirmed"`, `missing` → `"not found"`,
 * colors/`fg`/`bg` per branch — is IDENTICAL between the two screens today, which is exactly why
 * it is written once here instead of twice.
 */
export function buildAgentHealthBadge(
  health: AgentHealth,
  options: { readonly short: boolean },
  wording: AgentHealthBadgeWording,
): StatusBarHintBadge | null {
  if (health.kind === "ready") return null;
  // `checking` is the one shape that puts the name AFTER the verb (`⠹ checking codex`).
  if (health.kind === "checking") {
    const checking = options.short ? "⠹ checking" : `⠹ checking ${health.agent}`;
    return { text: `${checking}${wording.checkingSuffix}`, fg: "amberHi", bg: "line" };
  }
  if (health.kind === "advisory") {
    // The engine's own `agentBadge` `:215`: `detail==='sandbox' ? 'sandbox degraded' : 'health
    // unconfirmed'`; `home()`'s own inline `statusBar()` call draws the identical ternary at
    // `:192` for Home specifically — same wording, two design call sites, one implementation
    // here. Neither carries the agent name, so `short` changes nothing here.
    return {
      text: health.panel === "sandbox" ? "⚠ sandbox degraded" : "⚠ health unconfirmed",
      fg: "amberHi",
      bg: "line",
    };
  }
  const name = options.short ? "" : `${health.agent} `;
  if (health.kind === "blocked") {
    return {
      text: health.panel === "latched" ? wording.latchedText(name) : `✗ ${name}not signed in`,
      fg: "bg",
      bg: "red",
    };
  }
  return { text: `✗ ${name}not found`, fg: "bg", bg: "red" };
}

/**
 * `agentHealthBadge`'s wording for {@link buildAgentHealthBadge}'s two divergence points — design
 * 30's own `{agent} unavailable` for `latched`, no `checking` tail (the Workspace composer is not
 * health-gated, unlike Home's Enter key). See the builder's doc comment for the full rationale.
 */
const AGENT_HEALTH_BADGE_WORDING: AgentHealthBadgeWording = {
  checkingSuffix: "",
  latchedText: (name) => `✗ ${name}unavailable`,
};

/**
 * The status-bar `hint` badge for one health reading, built by {@link buildAgentHealthBadge} with
 * this module's own wording (see that function's doc comment for the full five-branch vocabulary
 * and the two documented divergences from `Home.tsx`'s own `homeStatusBadge`, which calls the
 * same builder with its own wording instead).
 */
export function agentHealthBadge(
  health: AgentHealth,
  options: { readonly short: boolean },
): StatusBarHintBadge | null {
  return buildAgentHealthBadge(health, options, AGENT_HEALTH_BADGE_WORDING);
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

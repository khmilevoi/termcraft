/**
 * `ui/agent-health` — the agent CLI's health reading, and nothing else. Extracted from `ui/home`
 * (2026-08-02, workspace-first launch) once the Workspace status bar became its second consumer:
 * leaving the type, the atom and the action named after Home would have made `ui/workspace`
 * depend on `ui/home` and made all three names false. The module holds no logic, so it is
 * `types.ts` + `index.ts` with no subfolders (CLAUDE.md permits both files at a module root).
 *
 * Home's own submit policy (`homeSubmitAllowed`) deliberately did NOT move: the Workspace
 * composer is not gated on health (a dead CLI does not disable ⏎ there), so that function is
 * Home's rule, not this module's.
 */

/**
 * The five agent-health outcomes (finding §2.7). They divide by WHETHER SUBMIT IS REFUSED, not by
 * presence — which is why the old `present: boolean` could not express them: `checking` and
 * `blocked` both refuse while being nothing alike on screen, and `advisory` allows while being
 * visually closer to `blocked` than to `ready`.
 *
 * - `checking` — the probe is in flight. Home refuses submit. Design `home('checking')`
 *   (`termcraft-engine.js:139-161`): the `⏎ create` hint drops to faint, a `· ⠹ checking {agent} —
 *   up to 20s` note sits beside it, and the status bar carries `⠹ checking {agent} — ⏎ disabled`
 *   with the `⏎` hint key in the `dis` state. In the WORKSPACE it renders as an ordinary badge
 *   (`agentBadge('checking')`, `termcraft-engine.js:212-218`) and gates nothing.
 * - `ready` — a real, passing probe. Submit allowed. No badge on either screen.
 * - `advisory` — the probe finished without proving the agent healthy (an unconfirmed exit, a
 *   degraded sandbox, or a TIMEOUT). Submit ALLOWED: a timeout proves nothing — it does not prove
 *   the user is signed out — and the design's own `⏎ works — the first turn may still fail` panel
 *   is the honest bucket for "unproven". Design `homeHealth('shutdown'|'sandbox')`.
 * - `blocked` — the CLI is there and something positively established it cannot run right now.
 *   Home refuses submit, but the screen is NOT seized: a panel below a still-rendered (but
 *   disabled) prompt. TWO distinct reasons share this kind, told apart by `panel`: `"login"` is
 *   design's own `homeHealth('login')` (not signed in — probing again might change the answer);
 *   `"latched"` is the backend's own confirmed unconfirmed-exit lockout
 *   (`agent/claude/backend/model/backend.ts`). Design DOES mock this exact wording —
 *   `homeHealth('shutdown')` — but classifies it advisory (`design/termcraft-engine.js:165-166`'s
 *   own comment, predating the backend's latch); this union departs from that classification on
 *   purpose (`entrypoint/model/agent-health.ts`'s switch has the full argument), so `latched`'s
 *   PANEL CONTENT is still a documented divergence (`HomeHealthPanel.tsx`'s own `panelSpec`) even
 *   though its wording is design-adjacent. Collapsing `"latched"` into `advisory` (as this union
 *   briefly did) would tell the user Enter works when a real turn would be rejected.
 * - `missing` — no CLI at all. On Home it keeps the full-screen takeover (`homeErr()`). In the
 *   Workspace there is no takeover: a project is open and five of its six capabilities work
 *   without an agent, so it is a badge like the rest (`agentBadge('missing')`).
 */
export type AgentHealth =
  | Readonly<{ kind: "checking"; agent: string }>
  | Readonly<{ kind: "ready"; agent: string }>
  | Readonly<{ kind: "advisory"; agent: string; panel: "shutdown" | "sandbox"; detail: string }>
  | Readonly<{ kind: "blocked"; agent: string; panel: "login" | "latched"; detail: string }>
  | Readonly<{ kind: "missing"; agent: string; detail: string }>;

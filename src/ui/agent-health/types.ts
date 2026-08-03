/**
 * `ui/agent-health` — the agent CLI's health reading, and nothing else. Extracted from `ui/home`
 * (spec 2026-08-02 §"Module extraction") once the Workspace status bar started reading it too:
 * leaving it in `ui/home` would have made `ui/workspace` depend on `ui/home` and made every one
 * of its names — `HomeAgentHealth`, `local.homeHealth`, `refreshHomeHealth` — false.
 *
 * Home's own submit policy (`homeSubmitAllowed`) deliberately did NOT move: it is Home's, and
 * the Workspace composer is explicitly not gated on health (spec §"Decisions").
 */

/**
 * The five agent-health outcomes (finding §2.7). They divide by WHETHER SUBMIT IS REFUSED, not by
 * presence — which is why the old `present: boolean` could not express them: `checking` and
 * `blocked` both refuse while being nothing alike on screen, and `advisory` allows while being
 * visually closer to `blocked` than to `ready`.
 *
 * - `checking` — the probe is in flight. Submit refused. Design `home('checking')`
 *   (`termcraft-engine.js:139-161`): the `⏎ create` hint drops to faint, a `· ⠹ checking {agent} —
 *   up to 20s` note sits beside it, and the status bar carries `⠹ checking {agent} — ⏎ disabled`
 *   with the `⏎` hint key in the `dis` state.
 * - `ready` — a real, passing probe. Submit allowed. NOTE: there is no `● {agent} … · agent ready`
 *   line any more — the design's own `home()` no longer draws one, and it was the single assertion
 *   that was FALSE for the whole time the probe ran.
 * - `advisory` — the probe finished without proving the agent healthy (an unconfirmed exit, a
 *   degraded sandbox, or a TIMEOUT). Submit ALLOWED: a timeout proves nothing — it does not prove
 *   the user is signed out — and the design's own `⏎ works — the first turn may still fail` panel
 *   is the honest bucket for "unproven". Design `homeHealth('shutdown'|'sandbox')`.
 * - `blocked` — the CLI is there and something positively established it cannot run right now.
 *   Submit refused, but the screen is NOT seized: a panel below a still-rendered (but disabled —
 *   fix round 1, Finding 6) prompt. TWO distinct reasons share this kind, told apart by `panel`
 *   (fix round 1, Finding 3 — added beyond the brief's own sketch, which had `blocked` carry no
 *   `panel` at all and so could not distinguish them): `"login"` is design's own `homeHealth
 *   ('login')` (not signed in — probing again might change the answer); `"latched"` is the
 *   backend's own confirmed unconfirmed-exit lockout (`agent/claude/backend/model/backend.ts`).
 *   Design DOES mock this exact wording — `homeHealth('shutdown')` — but classifies it advisory
 *   (`design/termcraft-engine.js:165-166`'s own comment, predating the backend's latch); this
 *   union departs from that classification on purpose (`entrypoint/model/agent-health.ts`'s
 *   switch has the full argument), so `latched`'s PANEL CONTENT is still a documented divergence
 *   (`HomeHealthPanel.tsx`'s own `panelSpec`) even though its wording is design-adjacent.
 *   Collapsing `"latched"` into `advisory` (as this union briefly did) would tell the user Enter
 *   works when a real turn would be rejected.
 * - `missing` — no CLI at all. The one case that keeps the full-screen takeover (`homeErr()`).
 */
export type AgentHealth =
  | Readonly<{ kind: "checking"; agent: string }>
  | Readonly<{ kind: "ready"; agent: string }>
  | Readonly<{ kind: "advisory"; agent: string; panel: "shutdown" | "sandbox"; detail: string }>
  | Readonly<{ kind: "blocked"; agent: string; panel: "login" | "latched"; detail: string }>
  | Readonly<{ kind: "missing"; agent: string; detail: string }>;

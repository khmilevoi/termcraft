/**
 * `ui/home` — the Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Home is only ever shown before `.termcraft/` exists; an
 * existing project opens straight into Workspace. No chat/preview split, no tab strip.
 */

/**
 * The five Home health outcomes (finding §2.7). They divide by WHETHER SUBMIT IS REFUSED, not by
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
 *   backend's own confirmed unconfirmed-exit lockout (`agent/claude/backend/model/backend.ts`) —
 *   no design mock exists for it, so its panel content is a documented divergence
 *   (`HomeHealthPanel.tsx`'s own `panelSpec`). Collapsing `"latched"` into `advisory` (as this
 *   union briefly did) would tell the user Enter works when a real turn would be rejected.
 * - `missing` — no CLI at all. The one case that keeps the full-screen takeover (`homeErr()`).
 */
export type HomeAgentHealth =
  | Readonly<{ kind: "checking"; agent: string }>
  | Readonly<{ kind: "ready"; agent: string }>
  | Readonly<{ kind: "advisory"; agent: string; panel: "shutdown" | "sandbox"; detail: string }>
  | Readonly<{ kind: "blocked"; agent: string; panel: "login" | "latched"; detail: string }>
  | Readonly<{ kind: "missing"; agent: string; detail: string }>;

/** Submit is refused exactly while the agent is unproven-and-unusable — see {@link HomeAgentHealth}. */
export function homeSubmitAllowed(health: HomeAgentHealth): boolean {
  return health.kind === "ready" || health.kind === "advisory";
}

/**
 * Alias matching this task's own interface contract (Task 15's "Produces" section) — the exact
 * same union as {@link HomeAgentHealth}, named for downstream tasks that dispatch against it.
 */
export type HomeHealthOutcome = HomeAgentHealth;

/**
 * The agent/model/effort triple Home's combo selectors read (finding §2.7, phase-8 Task 13). A
 * synchronous fact the composition root resolves off the agent registry at construction
 * (`entrypoint/model/agent-health.ts`'s own `HomeAgentSelection`) — mirrored here, not
 * imported: `ui` never imports `entrypoint` (code-structure.md's DAG has the composition root
 * importing every module, never the reverse), so the two declarations are kept structurally
 * identical by convention, the same "verbatim lift" pattern `core/ports/agent-backend.ts`
 * already uses for `agent/types.ts`. `HomeCombo` below is the always-concrete render-ready
 * triple this feeds; `HomeAgentSelection | null` is the honest upstream fact — `null` only when
 * the registry could not name a default (no registry, or an empty catalog), never a fabricated
 * identity.
 */
export interface HomeAgentSelection {
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
}

/** The inline agent/model/effort combo selectors shown under the prompt box. */
export interface HomeCombo {
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
}

/** Props for the `Home` screen component. `id` is the mandatory stable id. */
export interface HomeProps {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly health: HomeAgentHealth;
  /** Current prompt text (empty string shows the placeholder). */
  readonly prompt: string;
  readonly combo: HomeCombo;
}

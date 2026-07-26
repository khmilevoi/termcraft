import { Spinner } from "ui/spinner";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey } from "ui/status-bar";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { homeSubmitAllowed } from "../types";
import type { HomeAgentHealth, HomeCombo, HomeProps } from "../types";
import { HomeHealthPanel } from "./HomeHealthPanel";

const LOGO = "❯ termcraft";
const TAGLINE = "design terminal UIs by describing them";
const PLACEHOLDER = "Describe the TUI you want to design…";
const CURSOR_GLYPH = "█";

// Prompt-box width/height follow design `home()`'s `iw=min(w-16,84)` / `boxH=6`
// constants (design/termcraft-engine.js:130) — the box shrinks with narrow terminals
// but never exceeds 84 cells, matching the mock's centered-prompt sizing.
const promptBoxWidth = (width: number) => Math.min(width - 16, 84);
const PROMPT_BOX_HEIGHT = 6;

const BOLD = shellAttrs({ bold: true });
const BLINK_CURSOR = shellAttrs({ blink: true });

/**
 * Mirrors design `home()`'s `acx` running-x bookkeeping (`design/termcraft-engine.js:149-152`) to
 * decide whether the `· / model` hint fits after the combo row's own live agent/model/effort
 * text (not the design's `codex`/`gpt-5.5`/`high` sample data, which this screen never renders).
 * The design's own box-start offset (`ix`) cancels out of its `acx+10<=ix+iw-2` check — both
 * sides shift by the same amount — so only `iw` and the combo's rendered widths matter here.
 */
function fitsModelHint(iw: number, combo: HomeCombo): boolean {
  const selWidth = (label: string, value: string) => label.length + 1 + value.length + 3;
  const acx =
    2 +
    selWidth("agent", combo.agent) +
    selWidth("model", combo.model) +
    selWidth("effort", combo.effort);
  return acx + 10 <= iw - 2;
}

/**
 * The idle Home status bar's key hints (design `home()`, `design/termcraft-engine.js:144-145`:
 * `this.statusBar(b,h-1,[...],[['⏎','create'],['q','quit']])`), extended for the checking/blocked
 * outcomes (finding §2.7, phase-8 Task 15): the `⏎` hint carries the `dis` state exactly when
 * {@link homeSubmitAllowed} refuses it (design `:161`/`:194`), and `r` re-check joins the row only
 * for `blocked` — matching `keymap.ts`'s own Home branch, which wires the `r` key exclusively
 * there (design `homeHealth('login')`'s status bar, `:194`; `checking`/`advisory` have no `r`
 * handler, so no `r` hint is shown for them). DIVERGENCE (read verbatim before writing this): the
 * design hints read `q quit`, but this screen's own frame shows a focused prompt with a blinking
 * text cursor (design/termcraft-engine.js:135-137) — `q` must type into it (keymap.ts's Home
 * branch does exactly that whenever the health outcome keeps a live prompt). Rebinding `q` to quit
 * here — "quit while the prompt happens to be empty" — would eject a user mid-keystroke into
 * "quick dashboard" or any other prompt starting with `q`. `/exit` (the quit affordance that never
 * collides with typing) names it instead, on every outcome that keeps the prompt live.
 */
function homeIdleHintKeys(health: HomeAgentHealth): readonly StatusBarHintKey[] {
  const submitKey: StatusBarHintKey = homeSubmitAllowed(health)
    ? ["⏎", "create"]
    : ["⏎", "create", "dis"];
  if (health.kind === "blocked") return [["r", "re-check"], submitKey, ["/exit", "quit"]];
  return [submitKey, ["/exit", "quit"]];
}

/** The idle Home screen: centered prompt, combo selectors, health panel/badge, status bar. */
function HomeIdle(props: HomeProps) {
  const { health } = props;
  const iw = promptBoxWidth(props.width);
  const hasPrompt = props.prompt.length > 0;
  const checking = health.kind === "checking";
  // Design `homeHealth('login')` dims the shared "describe" prompt box itself (frame color,
  // caret, cursor) for the blocking outcome only — `checking`'s own box in `home()` stays
  // unconditionally amber (design/termcraft-engine.js:143), so this narrows to `blocked` alone.
  const blocked = health.kind === "blocked";
  // `⏎ create`'s inline hint (below the prompt box, NOT the status bar's own key row) drops to
  // faint on the SAME two outcomes that refuse submit and keep a live prompt — `checking`
  // (design `:147`) and `blocked` (design `:174`); `missing` never reaches this component.
  const createHintFaint = checking || blocked;
  const showHealthPanel = health.kind === "blocked" || health.kind === "advisory";
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      <box id={`${props.id}-content`} width={props.width} flexGrow={1} flexDirection="column">
        {
          // Two equal flexGrow spacers stand in for `justifyContent="center"` here — NOT a
          // stylistic choice: with a `StatusBar` sibling now present below this box (this
          // task's own addition), OpenTUI/Yoga's `justifyContent="center"` on this box
          // miscomputes the centered group's children's row offsets, overlapping two of them
          // onto the same row (verified empirically: reproduces with either an explicit
          // `height` or `flexGrow` on this box, and disappears the moment the StatusBar
          // sibling — or `justifyContent="center"` itself — is removed). Spacer flexGrow boxes
          // achieve the identical visual centering without tripping that computation. Design
          // absolute-positions the logo/tagline/box/health line around a computed `iy`
          // (design/termcraft-engine.js:130-143) either way — this was already the closest
          // faithful flexbox mapping of that canvas-absolute layout, just via a different
          // flexbox mechanism now.
        }
        <box id={`${props.id}-content-top-spacer`} flexGrow={1} />
        <box id={`${props.id}-content-center`} flexDirection="column" alignItems="center">
          <text id={`${props.id}-logo`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
            {LOGO}
          </text>
          <text id={`${props.id}-tagline`} fg={SHELL_PALETTE.dim}>
            {TAGLINE}
          </text>
          <box
            id={`${props.id}-prompt-box`}
            width={iw}
            height={PROMPT_BOX_HEIGHT}
            border
            borderStyle="rounded"
            borderColor={blocked ? SHELL_PALETTE.border : SHELL_PALETTE.amber}
            title="describe"
            titleColor={blocked ? SHELL_PALETTE.dim : SHELL_PALETTE.amberHi}
            flexDirection="column"
            padding={0}
          >
            <box id={`${props.id}-prompt-row`} flexDirection="row">
              <text
                id={`${props.id}-prompt-caret`}
                fg={blocked ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
                attributes={BOLD}
              >
                {"❯ "}
              </text>
              <text
                id={`${props.id}-prompt-text`}
                fg={hasPrompt ? SHELL_PALETTE.fg : SHELL_PALETTE.faint}
              >
                {hasPrompt ? props.prompt : PLACEHOLDER}
              </text>
              {
                // Design overlaps the blinking cursor onto the placeholder's first cell
                // (design/termcraft-engine.js:137, `put` after the placeholder `text`). Flexbox
                // can't overlap two siblings in the same cell, so the closest faithful mapping
                // appends the cursor right after the text — omitted entirely while `blocked`,
                // matching design `homeHealth('login')`'s own `if(!blocking) this.put(...)`
                // (`:173`), which never draws a cursor over a refused prompt.
                !blocked && (
                  <text
                    id={`${props.id}-prompt-cursor`}
                    fg={SHELL_PALETTE.amber}
                    attributes={BLINK_CURSOR}
                  >
                    {CURSOR_GLYPH}
                  </text>
                )
              }
            </box>
            <box id={`${props.id}-prompt-hint`} flexDirection="row">
              <text
                id={`${props.id}-prompt-hint-create`}
                fg={createHintFaint ? SHELL_PALETTE.faint : SHELL_PALETTE.dim}
              >
                {"⏎ create"}
              </text>
              {
                // The design draws this as one literal string (`'· ⠹ checking codex — up to
                // 20s'`, design/termcraft-engine.js:148) — a static mockup cannot animate. The
                // real component drives the `⠹` through `ui/spinner`'s shared `Spinner` instead,
                // so it actually ticks; `SPINNER_FRAMES`'s own phase-shift keeps frame 0
                // pixel-identical to the design's glyph.
                checking && (
                  <>
                    <text id={`${props.id}-prompt-hint-sep`} fg={SHELL_PALETTE.amberDim}>
                      {" · "}
                    </text>
                    <Spinner
                      id={`${props.id}-prompt-hint-spinner`}
                      label={`checking ${health.agent} — up to 20s`}
                      fg={SHELL_PALETTE.amberDim}
                    />
                  </>
                )
              }
            </box>
          </box>
          <box id={`${props.id}-combo`} flexDirection="row">
            <text id={`${props.id}-combo-agent-label`} fg={SHELL_PALETTE.faint}>
              {"agent "}
            </text>
            <text id={`${props.id}-combo-agent-value`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
              {`‹${props.combo.agent}›`}
            </text>
            <text id={`${props.id}-combo-model-label`} fg={SHELL_PALETTE.faint}>
              {"  model "}
            </text>
            <text id={`${props.id}-combo-model-value`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
              {`‹${props.combo.model}›`}
            </text>
            <text id={`${props.id}-combo-effort-label`} fg={SHELL_PALETTE.faint}>
              {"  effort "}
            </text>
            <text
              id={`${props.id}-combo-effort-value`}
              fg={SHELL_PALETTE.amberHi}
              attributes={BOLD}
            >
              {`‹${props.combo.effort}›`}
            </text>
            {
              // Design `home()` :152 — `· / model`, faint, only when the combo row leaves room.
              fitsModelHint(iw, props.combo) && (
                <text id={`${props.id}-combo-model-hint`} fg={SHELL_PALETTE.faint}>
                  {"  · / model"}
                </text>
              )
            }
          </box>
          {showHealthPanel && (
            <box id={`${props.id}-health-panel-slot`} marginTop={1}>
              <HomeHealthPanel id={`${props.id}-health-panel`} width={iw} health={health} />
            </box>
          )}
        </box>
        <box id={`${props.id}-content-bottom-spacer`} flexGrow={1} />
      </box>
      <StatusBar
        id={`${props.id}-status`}
        width={props.width}
        mode={{ text: "HOME", fg: "bg", bg: "amber" }}
        // DIVERGENCE (closest faithful mapping, documented per CLAUDE.md): design's raw
        // `statusBar()` takes an arbitrary left-segment list — here three: the mode chip, `"
        // no project yet"` (replaced by the checking badge while checking), and `"  gpt5.5 ·
        // high"` (design/termcraft-engine.js:144,157-160, its own sample agent/model data).
        // `StatusBarProps` has exactly one plain secondary slot (`page`), so the model/effort
        // piece lives there always, and — matching design's own REPLACEMENT (not addition) of
        // "no project yet" — `page` drops that literal while checking rather than keeping all
        // three segments' text simultaneously, which overflowed an 80-column bar. The checking
        // badge lands in `hint` (below), the fixed-shape API's closest faithful mapping of
        // design's own three-segment left cluster. `"no project yet"` is honest static fact
        // (Home only ever renders before a project exists); the model/effort piece is NOT the
        // design's Codex sample — it reads the SAME live `combo` this screen's own prompt-area
        // selectors already render, never an invented literal.
        page={{
          text: checking
            ? `${props.combo.model} · ${props.combo.effort}`
            : `no project yet  ${props.combo.model} · ${props.combo.effort}`,
          fg: "dim",
        }}
        hint={
          checking
            ? { text: `⠹ checking ${health.agent} — ⏎ disabled`, fg: "amberHi", bg: "line" }
            : null
        }
        hintKeys={homeIdleHintKeys(health)}
      />
    </box>
  );
}

// The agent-missing status bar's key hints, verbatim (design `homeErr()`,
// `design/termcraft-engine.js:583`: `[['r','re-check'],['q','quit']]`) — unlike idle Home,
// this screen has no text input at all (keymap.ts's Home branch makes every key but `r`/`q`
// inert here), so `q quit` is safe to keep exactly as drawn.
const HOME_AGENT_MISSING_HINT_KEYS: readonly StatusBarHintKey[] = [
  ["r", "re-check"],
  ["q", "quit"],
];

/** Props for {@link HomeAgentMissing} — `health` narrowed to the one outcome it ever renders. */
interface HomeAgentMissingProps {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly health: Extract<HomeAgentHealth, { kind: "missing" }>;
}

/** The agent-missing error variant (design `homeErr()`), replacing the whole screen. */
function HomeAgentMissing(props: HomeAgentMissingProps) {
  const { health } = props;
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      <box
        id={`${props.id}-content`}
        width={props.width}
        height={props.height - 1}
        flexDirection="column"
      >
        <box id={`${props.id}-logo-row`} flexDirection="row" justifyContent="center">
          <text id={`${props.id}-logo`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
            {LOGO}
          </text>
        </box>
        <box
          id={`${props.id}-agent-panel`}
          border
          borderStyle="rounded"
          borderColor={SHELL_PALETTE.red}
          title="agent"
          titleColor={SHELL_PALETTE.red}
          flexDirection="column"
          marginTop={1}
          padding={1}
        >
          <text id={`${props.id}-agent-missing`} fg={SHELL_PALETTE.red} attributes={BOLD}>
            {
              // WP-5 (phase-8 Task 9): the probe (`entrypoint/model/agent-health.ts`'s
              // `homeHealthFromAgentInfo`) distinguishes several not-ready reasons, but only
              // `missing` (no CLI at all) reaches this full-screen takeover any more (finding
              // §2.7, phase-8 Task 15) — `blocked`/`advisory` render `HomeHealthPanel` instead.
              // design/01-home.dc.html's `homeErr()` (design/termcraft-engine.js:576) mocks
              // exactly this one case, as the literal "✗ codex CLI not found". The headline
              // renders the probe's own honest `detail` text verbatim (never re-synthesized from
              // `agent`). The ✗ glyph stays static UI chrome here — it is not part of the
              // probe's `detail` string.
              `✗ ${health.detail}`
            }
          </text>
          <text id={`${props.id}-agent-need`} fg={SHELL_PALETTE.dim}>
            {`termcraft needs the ${health.agent} agent on your PATH.`}
          </text>
          <box id={`${props.id}-agent-install`} flexDirection="row">
            <text id={`${props.id}-agent-install-label`} fg={SHELL_PALETTE.faint}>
              {"install:"}
            </text>
            <text id={`${props.id}-agent-install-cmd`} fg={SHELL_PALETTE.amberHi}>
              {
                // DIVERGENCE (design sample data, not layout): design/01-home.dc.html's homeErr()
                // hardcodes the literal Codex npm package `npm i -g @openai/codex` (user decision
                // 2026-07-23). MVP ships Claude only and there is no data source for a real npm
                // scope per backend, so the package-name portion is driven by `health.agent`
                // instead of inventing one — never a hardcoded "@openai/codex".
                ` npm i -g ${health.agent}`
              }
            </text>
          </box>
          <text id={`${props.id}-agent-recheck`} fg={SHELL_PALETTE.faint}>
            {"then reopen, or press r to re-check"}
          </text>
        </box>
      </box>
      <StatusBar
        id={`${props.id}-status`}
        width={props.width}
        mode={{ text: "HOME", fg: "bg", bg: "amber" }}
        // The design's second segment is a red BADGE (`fg:P.bg, bg:P.red, bold:true`), not the
        // plain-dim `page` slot idle Home uses above — `StatusBarProps.hint` is the matching
        // slot for a contrasting-background badge. Text is the probe's own honest `detail`
        // (same divergence as the panel headline above: design mocks only the CLI-absent case).
        hint={{ text: `✗ ${health.detail}`, fg: "bg", bg: "red" }}
        hintKeys={HOME_AGENT_MISSING_HINT_KEYS}
      />
    </box>
  );
}

/**
 * The Home screen (design `home()`/`homeErr()`/`homeHealth()`, `design/01-home.dc.html`,
 * chrome-map "SURFACE: Home"). Only ever shown before `.termcraft/` exists — an existing project
 * opens straight into Workspace, so Home has no chat/preview split and no tab strip. Routes on
 * `health.kind` (finding §2.7, phase-8 Task 15): `missing` alone keeps the full-screen takeover
 * (`HomeAgentMissing`); every other outcome renders the idle centered-prompt layout, with
 * `HomeHealthPanel` layered in under the combo for `blocked`/`advisory`.
 */
export function Home(props: HomeProps) {
  const { health } = props;
  if (health.kind === "missing") return <HomeAgentMissing {...props} health={health} />;
  return <HomeIdle {...props} />;
}

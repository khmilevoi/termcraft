import { StatusBar } from "ui/status-bar";
import type { StatusBarHintKey } from "ui/status-bar";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { HomeProps } from "../types";

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

// DIVERGENCE (design sample data, not layout): design/01-home.dc.html's health line and
// agent-missing panel (design/01-home.dc.html's homeErr()) hardcode "codex" as sample data (user
// decision 2026-07-23). `health.agent` is optional in HomeAgentHealth's type — the M15 probe
// always supplies it in practice, but the fallback here stays the neutral empty string, never an
// invented identity like the design's Codex sample (M22).
const neutralAgentName = (health: HomeProps["health"]): string => health.agent ?? "";

// The idle Home status bar's key hints (design `home()`, `design/termcraft-engine.js:144-145`:
// `this.statusBar(b,h-1,[...],[['⏎','create'],['q','quit']])`). DIVERGENCE (read verbatim
// before writing this): the design hint reads `q quit`, but this screen's own frame shows a
// focused prompt with a blinking text cursor (design/termcraft-engine.js:135-137) — `q` must
// type into it (keymap.ts's Home branch does exactly that whenever `homeHealthPresent` is
// `true`). Rebinding `q` to quit here — "quit while the prompt happens to be empty" — would
// eject a user mid-keystroke into "quick dashboard" or any other prompt starting with `q`.
// `/exit` (this task's own command-registry addition, `ui/actions/model/registry.ts`) is the
// quit affordance that never collides with typing, so the hint names it instead.
const HOME_IDLE_HINT_KEYS: readonly StatusBarHintKey[] = [
  ["⏎", "create"],
  ["/exit", "quit"],
];

/** The idle Home screen: centered prompt, combo selectors, agent health line, status bar. */
function HomeIdle(props: HomeProps) {
  const iw = promptBoxWidth(props.width);
  const agentName = neutralAgentName(props.health);
  const version = props.health.version || "";
  const hasPrompt = props.prompt.length > 0;
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
            borderColor={SHELL_PALETTE.amber}
            title="describe"
            titleColor={SHELL_PALETTE.amberHi}
            flexDirection="column"
            padding={0}
          >
            <box id={`${props.id}-prompt-row`} flexDirection="row">
              <text id={`${props.id}-prompt-caret`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
                {"❯ "}
              </text>
              <text
                id={`${props.id}-prompt-text`}
                fg={hasPrompt ? SHELL_PALETTE.fg : SHELL_PALETTE.faint}
              >
                {hasPrompt ? props.prompt : PLACEHOLDER}
              </text>
              {
                // Design overlaps the blinking cursor onto the placeholder's first
                // cell (design/termcraft-engine.js:137, `put` after the placeholder
                // `text`). Flexbox can't overlap two siblings in the same cell, so the
                // closest faithful mapping appends the cursor right after the text.
              }
              <text
                id={`${props.id}-prompt-cursor`}
                fg={SHELL_PALETTE.amber}
                attributes={BLINK_CURSOR}
              >
                {CURSOR_GLYPH}
              </text>
            </box>
            <text id={`${props.id}-prompt-hint`} fg={SHELL_PALETTE.dim}>
              {"⏎ create"}
            </text>
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
          </box>
          <text id={`${props.id}-health`} fg={SHELL_PALETTE.green} attributes={BOLD}>
            {`● ${agentName} ${version} · ${props.health.detail}`}
          </text>
        </box>
        <box id={`${props.id}-content-bottom-spacer`} flexGrow={1} />
      </box>
      <StatusBar
        id={`${props.id}-status`}
        width={props.width}
        mode={{ text: "HOME", fg: "bg", bg: "amber" }}
        // DIVERGENCE (closest faithful mapping, documented per CLAUDE.md): design's raw
        // `statusBar()` takes an arbitrary left-segment list — here three: the mode chip, `"
        // no project yet"`, and `"  gpt5.5 · high"` (design/termcraft-engine.js:144, its own
        // sample agent/model data). `StatusBarProps` has exactly one plain secondary slot
        // (`page`), so both fold into it. The literal `"no project yet"` is honest static fact
        // (Home only ever renders before a project exists); the model/effort piece is NOT the
        // design's Codex sample — it reads the SAME live `combo` this screen's own prompt-area
        // selectors already render, never an invented literal.
        page={{ text: `no project yet  ${props.combo.model} · ${props.combo.effort}`, fg: "dim" }}
        hintKeys={HOME_IDLE_HINT_KEYS}
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

/** The agent-missing error variant (design `homeErr()`), replacing the whole screen. */
function HomeAgentMissing(props: HomeProps) {
  const agentName = neutralAgentName(props.health);
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
              // `homeHealthFromAgentInfo`) now distinguishes three not-present reasons — CLI
              // absent, CLI present but not logged in, and an inconclusive probe (an
              // unconfirmed process exit) — but design/01-home.dc.html's `homeErr()`
              // (design/termcraft-engine.js:576) mocks ONLY the CLI-absent case, as the single
              // literal "✗ codex CLI not found". This is the ONE agent-missing screen the
              // design draws, so all three reasons reuse it rather than inventing two more
              // screens the design never mocked: the headline renders the probe's own honest
              // `detail` text verbatim (never re-synthesized from `agentName`). The ✗ glyph
              // stays static UI chrome here — it is not part of any probe's `detail` string.
              `✗ ${props.health.detail}`
            }
          </text>
          <text id={`${props.id}-agent-need`} fg={SHELL_PALETTE.dim}>
            {`termcraft needs the ${agentName} agent on your PATH.`}
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
                // scope per backend, so the package-name portion is driven by `agentName` instead
                // of inventing one — never a hardcoded "@openai/codex".
                ` npm i -g ${agentName}`
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
        hint={{ text: `✗ ${props.health.detail}`, fg: "bg", bg: "red" }}
        hintKeys={HOME_AGENT_MISSING_HINT_KEYS}
      />
    </box>
  );
}

/**
 * The Home screen (design `home()`/`homeErr()`, `design/01-home.dc.html`, chrome-map
 * "SURFACE: Home"). Only ever shown before `.termcraft/` exists — an existing project
 * opens straight into Workspace, so Home has no chat/preview split and no tab strip.
 * Renders the idle centered-prompt layout, or replaces it entirely with the
 * agent-missing error panel when `health.present` is `false`.
 */
export function Home(props: HomeProps) {
  if (!props.health.present) return <HomeAgentMissing {...props} />;
  return <HomeIdle {...props} />;
}

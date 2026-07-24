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

/** The idle Home screen: centered prompt, combo selectors, agent health line. */
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
      alignItems="center"
      // Design absolute-positions the logo/tagline/box/health line around a
      // computed `iy` (design/termcraft-engine.js:130-143). Flexbox center-stacking
      // is the closest faithful mapping — rows are not pixel-identical to the mock.
      justifyContent="center"
    >
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
          <text id={`${props.id}-prompt-cursor`} fg={SHELL_PALETTE.amber} attributes={BLINK_CURSOR}>
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
        <text id={`${props.id}-combo-effort-value`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
          {`‹${props.combo.effort}›`}
        </text>
      </box>
      <text id={`${props.id}-health`} fg={SHELL_PALETTE.green} attributes={BOLD}>
        {`● ${agentName} ${version} · ${props.health.detail}`}
      </text>
    </box>
  );
}

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
          {`✗ ${agentName} CLI not found`}
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

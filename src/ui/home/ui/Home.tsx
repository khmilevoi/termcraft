import { SlashMenu } from "ui/slash-menu";
import { Spinner } from "ui/spinner";
import { StatusBar } from "ui/status-bar";
import type { StatusBarHintBadge, StatusBarHintKey } from "ui/status-bar";
import { TextEditor, editorRowCount } from "ui/text-input";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { homeSubmitAllowed } from "../types";
import type { HomeAgentHealth, HomeCombo, HomeProps } from "../types";
import { HomeHealthPanel } from "./HomeHealthPanel";
import { HomeOpenFailurePanel } from "./HomeOpenFailurePanel";

const LOGO = "❯ termcraft";
const TAGLINE = "design terminal UIs by describing them";
const PLACEHOLDER = "Describe the TUI you want to design…";

// Prompt-box width/height follow design `home()`'s `iw=min(w-16,84)` / `boxH=6`
// constants (design/termcraft-engine.js:139 — `const iw=Math.min(w-16,84); const
// ix=Math.floor((w-iw)/2); const boxH=6;`; CORRECTED fix round 1, was miscited `:130`, a blank
// line) — the box shrinks with narrow terminals but never exceeds 84 cells, matching the mock's
// centered-prompt sizing.
const promptBoxWidth = (width: number) => Math.min(width - 16, 84);
const PROMPT_BOX_HEIGHT = 6;

/** The `❯ ` caret run drawn before the editor — two cells, matching design `home()` `:145`. */
const PROMPT_CARET_COLUMNS = 2;

const BOLD = shellAttrs({ bold: true });

/**
 * Whether the `· / model` hint fits after the combo row (design `home()` `:152` —
 * `if(acx+10<=ix+iw-2) this.text(b,acx,yy,'· / model',{fg:P.faint});`). CORRECTED (fix round 1,
 * Minor finding): this used to re-derive design's own internal `acx` gap bookkeeping (`:149-151`),
 * which uses a DIFFERENT label/gap convention than this component's own literal strings
 * (`"  model "`/`"  effort "` here vs. design's dynamically-advanced single-cell gaps) and
 * under-measured real width by roughly five columns at boundary sizes. This measures THIS
 * component's own rendered pre-hint text directly instead — a literal transcription of the JSX
 * below, not a re-derivation of a different layout's arithmetic. `iw` stands in for the same
 * visual budget design's own check ties the hint to; there is no literal clipping box around the
 * combo row in this flexbox layout (unlike the bordered "describe" box above it), so this is a
 * faithful-intent transfer, not a pixel-for-pixel corner-case match.
 */
function fitsModelHint(iw: number, combo: HomeCombo): boolean {
  const preHint = `agent ‹${combo.agent}›  model ‹${combo.model}›  effort ‹${combo.effort}›`;
  const hint = "  · / model";
  return preHint.length + hint.length <= iw;
}

/**
 * The status-bar hint badge for outcomes that need one — `checking` (design `home('checking')`
 * `:158`) and `homeHealth(kind)`'s three panels plus `blocked/latched` (`:191-192`, extended
 * fix round 1 Finding 5). `ready` gets none — its `page` text below is the entire status-bar
 * footprint.
 */
function homeStatusBadge(health: HomeAgentHealth): StatusBarHintBadge | null {
  if (health.kind === "checking") {
    // Design draws this glyph as a static `⠹` too (`:148`,`:158` — a static mockup cannot
    // animate) — DIVERGENCE (fix round 1, Minor finding): this component's OWN `⠹` here is
    // static (a plain string, unlike `StatusBarHintBadge` which cannot host a live component),
    // while the inline note beside the prompt (below) drives its `⠹` through a live `Spinner` —
    // so after the first tick the two glyphs on screen fall out of phase with each other. Both
    // are this component's own animation choice, not design's; design draws neither moving.
    return { text: `⠹ checking ${health.agent} — ⏎ disabled`, fg: "amberHi", bg: "line" };
  }
  if (health.kind === "blocked") {
    if (health.panel === "login") {
      return { text: `✗ ${health.agent} not signed in`, fg: "bg", bg: "red" };
    }
    // DIVERGENCE (fix round 1, Finding 3/5; corrected fix round 2): design's `homeHealth()` never
    // treats an unconfirmed exit as blocking at all (`:165-166`'s own comment classifies it
    // advisory — see `entrypoint/model/agent-health.ts`'s switch for the full argument for why
    // this port departs from that), so it has no RED/blocking badge for this cause — closest
    // faithful mapping of design's own `✗ codex not signed in` badge shape (`:191`), honest
    // wording for this cause instead of `login`'s (wrong, for this cause) text.
    return { text: `✗ ${health.agent} locked out`, fg: "bg", bg: "red" };
  }
  if (health.kind === "advisory") {
    // Design `:192` — `' ⚠ '+(kind==='sandbox'?'sandbox degraded':'health unconfirmed')+' '`.
    const label = health.panel === "sandbox" ? "sandbox degraded" : "health unconfirmed";
    return { text: `⚠ ${label}`, fg: "amberHi", bg: "line" };
  }
  return null;
}

/**
 * The idle Home status bar's key hints (design `home()`, `design/termcraft-engine.js:161` —
 * `this.statusBar(b,h-1,left, checking?[['⏎','create','dis'],['q','quit']]:[['⏎','create'],
 * ['q','quit']]);`; CORRECTED fix round 1, was miscited `:144-145`, the caret draw and the
 * `typed` ternary), extended for the blocked outcome (finding §2.7, phase-8 Task 15): the `⏎`
 * hint carries the `dis` state exactly when {@link homeSubmitAllowed} refuses it, and `r`
 * re-check joins the row for `blocked` — matching `keymap.ts`'s own Home branch (design
 * `homeHealth('login')`'s status bar, `:194`).
 *
 * DIVERGENCE (read verbatim before writing this): design's own hints read `q quit` on every
 * outcome, but `checking`/`advisory`/`ready` keep a genuinely live, typeable prompt (design
 * draws a blinking cursor for all three — `:145-146`, `:173`), so `q` must type into it there
 * (`keymap.ts`'s Home branch does exactly that). `/exit` (the quit affordance that never
 * collides with typing) names it instead for those three. `blocked` is DIFFERENT (fix round 1,
 * Finding 6): its prompt is now genuinely disabled, not merely dimmed — see `keymap.ts`'s own
 * comment — so it has no typing to collide with, and reads design's own literal `q` verbatim,
 * matching `missing`'s existing literal `q` too.
 *
 * `advisory` gets NO `r` hint despite design showing one for it too (`:194`): unlike `blocked`,
 * `advisory` keeps its prompt genuinely live (design's own cursor, `:173`) — binding bare `r`
 * there would recreate the exact character-stealing bug `blocked` just had, and this module's
 * own `q`→`/exit` precedent above exists specifically to avoid that class of bug. A shown-but-
 * unwired hint would mislead, so none is shown; `keymap.ts` wires no `r` handler for `advisory`.
 */
function homeIdleHintKeys(health: HomeAgentHealth, opening: boolean): readonly StatusBarHintKey[] {
  // `opening` refuses submit for the same reason `checking` does — the command would be rejected
  // — so it wears the same `dis` treatment rather than advertising a key that does nothing.
  const submitKey: StatusBarHintKey =
    homeSubmitAllowed(health) && !opening ? ["⏎", "create"] : ["⏎", "create", "dis"];
  if (health.kind === "blocked") return [["r", "re-check"], submitKey, ["q", "quit"]];
  return [submitKey, ["/exit", "quit"]];
}

/** The idle Home screen: centered prompt, combo selectors, health panel/badge, status bar. */
function HomeIdle(props: HomeProps) {
  const { health } = props;
  const iw = promptBoxWidth(props.width);
  // The editor wraps inside the bordered box: its width less the border and the caret run. The
  // box grows with it, keeping design's own `boxH=6` (`design/termcraft-engine.js:139`) as the
  // one-row case exactly — the same approved divergence the composer takes (spec §3).
  const promptEditorWidth = Math.max(1, iw - 2 - PROMPT_CARET_COLUMNS);
  const promptEditorRows = editorRowCount({
    text: props.prompt,
    width: promptEditorWidth,
    frameH: props.height - 1,
  });
  const checking = health.kind === "checking";
  // Design `homeHealth('login')` dims the shared "describe" prompt box itself (frame color,
  // caret, cursor) for the blocking outcome only — `checking`'s own box in `home()` stays
  // unconditionally amber (design/termcraft-engine.js:143), so this narrows to `blocked` alone.
  const blocked = health.kind === "blocked";
  // `⏎ create`'s inline hint (below the prompt box, NOT the status bar's own key row) drops to
  // faint on the SAME two outcomes that refuse submit — `checking` (design `:147`) and `blocked`
  // (design `:174`); `missing` never reaches this component.
  const createHintFaint = checking || blocked || props.opening;
  const showHealthPanel = health.kind === "blocked" || health.kind === "advisory";
  const badge = homeStatusBadge(health);
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
          // (design/termcraft-engine.js:139-146 — CORRECTED fix round 1, was miscited
          // `:130-143`) either way — this was already the closest faithful flexbox mapping of
          // that canvas-absolute layout, just via a different flexbox mechanism now.
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
            height={PROMPT_BOX_HEIGHT + promptEditorRows - 1}
            border
            borderStyle="rounded"
            borderColor={blocked ? SHELL_PALETTE.border : SHELL_PALETTE.amber}
            title="describe"
            titleColor={blocked ? SHELL_PALETTE.dim : SHELL_PALETTE.amberHi}
            flexDirection="column"
            padding={0}
          >
            {
              // Design overlaps the blinking cursor onto the placeholder's first cell
              // (design/termcraft-engine.js:145-146, `put` at the SAME column as the preceding
              // `text`) — `TextEditor` reproduces that by construction — the cursor is the
              // terminal's own, and it physically occupies the placeholder's first cell. Cursor
              // omitted entirely while `blocked`, matching design `homeHealth('login')`'s own
              // `if(!blocking) this.put(...)` (`:173`), which never draws a cursor over a refused
              // prompt. `blocked`'s own prompt is also genuinely non-interactive now (`keymap.ts`'s
              // own comment, fix round 1 Finding 6) — appearance matches behaviour on both counts.
            }
            <TextEditor
              id={`${props.id}-prompt-row`}
              placeholder={PLACEHOLDER}
              caret={"❯ "}
              caretFg={blocked ? SHELL_PALETTE.faint : SHELL_PALETTE.amber}
              valueFg={SHELL_PALETTE.fg}
              placeholderFg={SHELL_PALETTE.faint}
              cursorFg={SHELL_PALETTE.amber}
              multiline
              rows={promptEditorRows}
              width={promptEditorWidth}
              // `blocked` is the one outcome with a genuinely non-interactive prompt (keymap.ts's
              // own fix-round-1 Finding 6): design `homeHealth('login')` `:173` draws no cursor
              // over a refused prompt, and blurring it is what makes the `r`/`q` keys safe to bind
              // literally there. `missing` never reaches this component at all.
              focused={!blocked}
              showCursor={!blocked}
              bridge={props.promptBridge}
            />
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
                // pixel-identical to the design's glyph. DIVERGENCE (fix round 1, Minor
                // finding): the status bar's own checking badge (`homeStatusBadge` above) is
                // NOT similarly animated (`StatusBarHintBadge` is plain text), so the two `⠹`
                // glyphs on screen drift out of phase after the first tick — see that
                // function's own comment.
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
          {
            // §3.10, design/23-slash-menu.dc.html (phase-8 Task 17, finding §2.4): anchored
            // directly below the whole bordered "describe" block, left-edge aligned with it, at
            // design's own rect (`home()`, `design/termcraft-engine.js:154-155` —
            // `slashBox(b,ix,iy+boxH,Math.min(42,iw),rows,…)`: row `iy+boxH` sits immediately
            // below the box, which in the design's absolute canvas already contains the combo
            // selectors near its own bottom row (`:149-151`'s `yy=iy+4`, inside the box's
            // `iy..iy+5` span) — so the closest faithful mapping in THIS flexbox translation,
            // where the combo row is already Task 13's own sibling BELOW the border, anchors the
            // menu below that combo row too, not between it and the border. Width
            // `Math.min(42,iw)` verbatim; "· left-edge aligned" (23-slash-menu.dc.html's own
            // prose) is achieved by wrapping in an outer box of width `iw` — IDENTICAL to
            // `prompt-box`'s own width, so both are centered by the SAME parent
            // (`alignItems="center"`) to the SAME offset — with the narrower visible anchor
            // positioned at that outer box's own left edge (Yoga's default `alignItems:
            // "stretch"` places a sized child at the cross-axis start, not centered within it).
            // `rows` is empty whenever the menu is not open (§3.10: "the menu simply does not
            // open" is the same condition as "nothing to render here").
            props.rows.length > 0 && (
              <box id={`${props.id}-slash-align`} width={iw} marginTop={1}>
                <box id={`${props.id}-slash-anchor`} width={Math.min(42, iw)}>
                  <SlashMenu
                    id={`${props.id}-slash-menu`}
                    typed={props.prompt}
                    rows={props.rows}
                    selectedIndex={props.selectedIndex}
                  />
                </box>
              </box>
            )
          }
          {showHealthPanel && (
            <box id={`${props.id}-health-panel-slot`} marginTop={1}>
              <HomeHealthPanel id={`${props.id}-health-panel`} width={iw} health={health} />
            </box>
          )}
          {
            // Stacked BELOW the health panel rather than replacing it: the two report unrelated
            // facts (can the agent run / did the project open) and both can be true at once, so
            // suppressing either would hide a cause the user needs. See
            // {@link HomeOpenFailurePanel} for why this panel exists at all.
            props.openFailure !== null && (
              <box id={`${props.id}-open-failure-slot`} marginTop={1}>
                <HomeOpenFailurePanel
                  id={`${props.id}-open-failure`}
                  width={iw}
                  failure={props.openFailure}
                />
              </box>
            )
          }
        </box>
        <box id={`${props.id}-content-bottom-spacer`} flexGrow={1} />
      </box>
      <StatusBar
        id={`${props.id}-status`}
        width={props.width}
        mode={{ text: "HOME", fg: "bg", bg: "amber" }}
        // DIVERGENCE (closest faithful mapping, documented per CLAUDE.md): design's raw
        // `statusBar()` takes an arbitrary left-segment list — here three: the mode chip, `"
        // no project yet"` (replaced by a badge whenever one is shown — `checking`/`blocked`/
        // `advisory`), and `"  gpt5.5 · high"` (design/termcraft-engine.js:157-161, its own
        // sample agent/model data — CORRECTED fix round 1, was miscited `:144`, the caret draw).
        // `StatusBarProps` has exactly one plain secondary slot (`page`), so the model/effort
        // piece lives there always, and — matching design's own REPLACEMENT (not addition) of
        // "no project yet" — `page` drops that literal whenever a badge is shown, rather than
        // keeping all three segments' text simultaneously, which overflowed an 80-column bar.
        // The badge lands in `hint` (below), the fixed-shape API's closest faithful mapping of
        // design's own three-segment left cluster. `"no project yet"` is honest static fact
        // (Home only ever renders before a project exists); the model/effort piece is NOT the
        // design's Codex sample — it reads the SAME live `combo` this screen's own prompt-area
        // selectors already render, never an invented literal.
        page={{
          // `"no project yet"` is only honest while nothing is opening. CORRECTED (defect fix,
          // 2026-07-26): relaunching inside an existing project fires a startup `project.open`
          // whose multi-step ready sequence publishes nothing until it finishes, and Home stays
          // mounted for all of it — so this line asserted "no project yet" over a project that
          // was actively loading, for as long as the open took.
          text: props.opening
            ? `opening project…  ${props.combo.model} · ${props.combo.effort}`
            : health.kind === "ready"
              ? `no project yet  ${props.combo.model} · ${props.combo.effort}`
              : `${props.combo.model} · ${props.combo.effort}`,
          fg: "dim",
        }}
        hint={badge}
        hintKeys={homeIdleHintKeys(health, props.opening)}
      />
    </box>
  );
}

// The agent-missing status bar's key hints, verbatim (design `homeErr()`,
// `design/termcraft-engine.js:727` — CORRECTED fix round 1, was miscited `:583`, a chat-colour
// branch inside `chatSeq()` — `this.statusBar(b,h-1,[...],[['r','re-check'],['q','quit']]);`) —
// unlike idle Home, this screen has no text input at all (keymap.ts's Home branch makes every
// key but `r`/`q` inert here), so `q quit` is safe to keep exactly as drawn.
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
              // design/01-home.dc.html's `homeErr()` (design/termcraft-engine.js:720 —
              // CORRECTED fix round 1, was miscited `:576`, an unrelated `chatSeq()` branch)
              // mocks exactly this one case, as the literal "✗ codex CLI not found". The
              // headline renders the probe's own honest `detail` text verbatim (never
              // re-synthesized from `agent`). The ✗ glyph stays static UI chrome here — it is
              // not part of the probe's `detail` string.
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

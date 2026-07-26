import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { HomeAgentHealth } from "../types";

/** One line of `homeHealth(kind)`'s panel body — a static three-line spec per kind. */
interface PanelLine {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}

interface PanelSpec {
  readonly title: string;
  readonly titleColor: string;
  readonly lines: readonly [PanelLine, PanelLine, PanelLine];
}

/**
 * Transcribed verbatim from design `homeHealth(kind)`'s `spec` object
 * (`design/termcraft-engine.js:175-187`) — three lines per kind. The design's own sample agent
 * name (`codex`, sometimes suffixed `0.34`) is the standing sample-data divergence (M22): the
 * FIRST line of each kind is driven by `health.detail` instead of the literal design string,
 * because `detail` is this module's own honest, already-computed wording
 * (`entrypoint/model/agent-health.ts`'s `homeHealthFromAgentInfo`) built from the SAME pattern
 * minus a version number `AgentInfo` never carries — reusing it here (rather than re-deriving
 * `"{agent} 0.34 found · not signed in"`) is what keeps this panel from fabricating a version the
 * real probe never read (the project's hardest rule). The second/third lines carry no per-probe
 * fact, so they ARE the design's literal text, with `{agent}` substituted for `codex` wherever it
 * appears — matching the same substitution `Home.tsx`'s own agent-missing panel already documents.
 */
function panelSpec(health: Extract<HomeAgentHealth, { kind: "blocked" | "advisory" }>): PanelSpec {
  const P = SHELL_PALETTE;
  if (health.kind === "blocked") {
    return {
      title: "not signed in",
      titleColor: P.red,
      lines: [
        { text: `✗ ${health.detail}`, fg: P.red, bold: true },
        { text: `run ${health.agent} login, then r to re-check`, fg: P.dim },
        { text: "⏎ stays refused until the probe passes", fg: P.faint },
      ],
    };
  }
  if (health.panel === "sandbox") {
    return {
      title: "sandbox degraded",
      titleColor: P.amber,
      lines: [
        { text: `⚠ ${health.detail}`, fg: P.amberHi, bold: true },
        { text: "writes are not contained to this folder", fg: P.dim },
        { text: "⏎ works — designing is unaffected", fg: P.faint },
      ],
    };
  }
  return {
    title: "health unconfirmed",
    titleColor: P.amber,
    lines: [
      { text: `⚠ ${health.detail}`, fg: P.amberHi, bold: true },
      { text: "version read · health unproven", fg: P.dim },
      { text: "⏎ works — the first turn may still fail", fg: P.faint },
    ],
  };
}

export interface HomeHealthPanelProps {
  readonly id: string;
  readonly width: number;
  readonly health: Extract<HomeAgentHealth, { kind: "blocked" | "advisory" }>;
}

/**
 * The three health outcomes with no full-screen takeover (design `homeHealth(kind)`,
 * `design/termcraft-engine.js:165-195`): `blocked` ("login" in the design — found but not signed
 * in, blocking) and `advisory`'s two panels (`shutdown`/`sandbox`, both non-blocking). Rendered
 * below Home's prompt/combo, never replacing them — `Home.tsx` keeps `HomeAgentMissing`'s
 * full-screen takeover reserved for `missing` alone.
 */
export function HomeHealthPanel(props: HomeHealthPanelProps) {
  const spec = panelSpec(props.health);
  const [first, second, third] = spec.lines;
  return (
    <box
      id={props.id}
      width={props.width}
      border
      borderStyle="rounded"
      borderColor={spec.titleColor}
      title={spec.title}
      titleColor={spec.titleColor}
      flexDirection="column"
      padding={0}
    >
      <text
        id={`${props.id}-line-1`}
        fg={first.fg}
        attributes={shellAttrs({ bold: first.bold === true })}
      >
        {first.text}
      </text>
      <text
        id={`${props.id}-line-2`}
        fg={second.fg}
        attributes={shellAttrs({ bold: second.bold === true })}
      >
        {second.text}
      </text>
      <text
        id={`${props.id}-line-3`}
        fg={third.fg}
        attributes={shellAttrs({ bold: third.bold === true })}
      >
        {third.text}
      </text>
    </box>
  );
}

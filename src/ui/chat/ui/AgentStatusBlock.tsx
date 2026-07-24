import { SHELL_PALETTE, shellAttrs } from "ui/theme";

/** One live tool step in the ephemeral agent status block. */
export interface AgentToolStep {
  readonly op: string;
  readonly target: string;
  readonly done: boolean;
}

/** One Gate-rejection retry line (schema retry 1-3, design `wsErrRetry`). */
export interface AgentGateRetry {
  readonly retryNumber: number;
}

/** Props for `AgentStatusBlock`. `id` is the mandatory stable id (§3.2). */
export interface AgentStatusBlockProps {
  readonly id: string;
  /**
   * The agent's display name, e.g. `"claude"` (M22: sourced from the kernel snapshot's
   * `agentIdentity`, never a hardcoded literal like the design's `codex` sample data).
   */
  readonly agentName: string;
  /** The connection meta line, e.g. `"ratatui · connected"`. */
  readonly connection: string;
  /** A braille spinner glyph, e.g. `"⠹"`. */
  readonly spinner: string;
  readonly steps: readonly AgentToolStep[];
  /** The single faint reasoning ticker line; `null` renders nothing. */
  readonly reasoning: string | null;
  readonly gateRetries: readonly AgentGateRetry[];
}

/**
 * The ephemeral in-turn agent status block (design `drawChat`,
 * `design/03-workspace-generating.dc.html`, `design/14-first-generation.dc.html`).
 * Renders the agent presence line, the generating spinner, the live tool-step
 * stream, the single reasoning ticker line, and any Gate-retry lines — everything
 * the chat panel shows while a turn is in progress, before it either collapses into
 * a persisted record or ends in a system line. Purely presentational: the caller
 * supplies the already-derived step/retry lists from the `AgentEvent` stream.
 */
export function AgentStatusBlock(props: AgentStatusBlockProps) {
  return (
    <box id={props.id} flexDirection="column">
      <text
        id={`${props.id}-agent`}
        fg={SHELL_PALETTE.green}
        attributes={shellAttrs({ bold: true })}
      >
        {`● ${props.agentName}`}
      </text>
      <text id={`${props.id}-connection`} fg={SHELL_PALETTE.faint}>
        {props.connection}
      </text>
      <text
        id={`${props.id}-spinner`}
        fg={SHELL_PALETTE.amber}
        attributes={shellAttrs({ bold: true })}
      >
        {`${props.spinner} generating design…`}
      </text>
      {props.steps.map((step, index) => (
        // keyed intrinsic wrapper — function components carry no `key` in this
        // repo's no-@types/react environment (src/runtime/ui/list.tsx).
        <box key={`step-${index}`} id={`${props.id}-step-${index}`}>
          {/* divergence: design shows human-authored labels per tool call (e.g.
              "read current design"); the mirrored AgentEvent stream only carries
              op+target, so this renders "op target" verbatim instead. */}
          <text
            id={`${props.id}-step-${index}-text`}
            fg={step.done ? SHELL_PALETTE.green : SHELL_PALETTE.fg}
          >
            {`${step.done ? "✓ " : "▸ "}${step.op} ${step.target}`}
          </text>
        </box>
      ))}
      {props.reasoning !== null ? (
        <text id={`${props.id}-reasoning`} fg={SHELL_PALETTE.faint}>
          {`  ${props.reasoning}`}
        </text>
      ) : null}
      {props.gateRetries.map((retry, index) => (
        <box key={`retry-${index}`} id={`${props.id}-retry-${index}`}>
          <text id={`${props.id}-retry-${index}-text`} fg={SHELL_PALETTE.red}>
            {`✗ invalid design (schema) · retry ${retry.retryNumber}/3`}
          </text>
        </box>
      ))}
    </box>
  );
}

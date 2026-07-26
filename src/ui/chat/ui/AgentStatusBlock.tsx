import { Spinner } from "ui/spinner";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { RenderedTimelineEntry, TimelineFold } from "../model/turn-timeline";

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
  /** Feeds the spinner's `· 2m 40s` segment (design `:547`); `null` renders the spinner alone. */
  readonly startedAt: number | null;
  /** The counted head row (`▲ 6 earlier thoughts · 5 steps`, design `:539`); `null` when nothing was elided. */
  readonly fold: TimelineFold | null;
  /** The already-folded timeline rows, in order — output of `foldTurnTimeline` (`../model/turn-timeline`). */
  readonly entries: readonly RenderedTimelineEntry[];
  readonly gateRetries: readonly AgentGateRetry[];
}

/**
 * The ephemeral in-turn agent status block (design `drawChat`,
 * `design/03-workspace-generating.dc.html`, `design/14-first-generation.dc.html`).
 * Renders the agent presence line, the generating spinner, the ordered/foldable
 * timeline of tool steps and reasoning blocks (design `genTurn`/`thinkRow`/`foldRow`,
 * `design/termcraft-engine.js:511-565`), and any Gate-retry lines — everything the
 * chat panel shows while a turn is in progress, before it either collapses into a
 * persisted record or ends in a system line. Purely presentational: the caller
 * supplies the already-folded rows from `foldTurnTimeline` (`../model/turn-timeline`)
 * — nothing here wraps, tails, or elides on its own.
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
      {/* The shared animated spinner (`ui/spinner`) rather than a glyph threaded in as a prop:
          it is its own `reatomComponent`, so an 80ms tick repaints this one line instead of the
          whole status block. Colour and weight stay the design's (amber, bold). */}
      <Spinner
        id={`${props.id}-spinner`}
        label="generating design…"
        fg={SHELL_PALETTE.amber}
        bold
        startedAt={props.startedAt}
      />
      {props.fold !== null && (
        // `foldRow` (design `:562-564`): a `┊` gutter in `amberDim`, then the counted text
        // two columns in (`tx+2`), also `amberDim`, bold.
        <box id={`${props.id}-fold`} flexDirection="row">
          <text id={`${props.id}-fold-gutter`} fg={SHELL_PALETTE.amberDim}>
            {"┊ "}
          </text>
          <text
            id={`${props.id}-fold-text`}
            fg={SHELL_PALETTE.amberDim}
            attributes={shellAttrs({ bold: true })}
          >
            {`▲ ${props.fold.thoughts} earlier thoughts · ${props.fold.steps} steps`}
          </text>
        </box>
      )}
      {props.entries.map((entry, index) => (
        // keyed intrinsic wrapper — function components carry no `key` in this
        // repo's no-@types/react environment (src/runtime/ui/list.tsx).
        <box key={`entry-${index}`} id={`${props.id}-entry-${index}`} flexDirection="column">
          {entry.kind === "step" ? (
            // step row — unchanged from today: ✓ green when done, ▸ fg when active.
            // divergence: design shows human-authored labels per tool call (e.g.
            // "read current design"); the mirrored AgentEvent stream only carries
            // op+target, so this renders "op target" verbatim instead.
            <text
              id={`${props.id}-entry-${index}-text`}
              fg={entry.done ? SHELL_PALETTE.green : SHELL_PALETTE.fg}
            >
              {`${entry.done ? "✓ " : "▸ "}${entry.op} ${entry.target}`}
            </text>
          ) : (
            // reasoning row (`thinkRow`, design `:558-560`) — one row per line: `┊` gutter for
            // the clipped head of a LIVE block, `│` otherwise; the thread colours `amberDim`/
            // `line`, the text (two columns in) `dim`/`faint`, live vs. past.
            entry.lines.map((line, lineIndex) => (
              <box
                key={`line-${lineIndex}`}
                id={`${props.id}-entry-${index}-line-${lineIndex}`}
                flexDirection="row"
              >
                <text
                  id={`${props.id}-entry-${index}-line-${lineIndex}-gutter`}
                  fg={entry.live ? SHELL_PALETTE.amberDim : SHELL_PALETTE.line}
                >
                  {entry.live && entry.clipped && lineIndex === 0 ? "┊ " : "│ "}
                </text>
                <text
                  id={`${props.id}-entry-${index}-line-${lineIndex}-text`}
                  fg={entry.live ? SHELL_PALETTE.dim : SHELL_PALETTE.faint}
                >
                  {line}
                </text>
              </box>
            ))
          )}
        </box>
      ))}
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

import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { MarkdownLine, MarkdownSpan } from "../model/markdown-lite";

/**
 * Props for the collapsed, persisted chat record (design §3.2 "Markdown-lite chat
 * record"). `lines` are already-parsed markdown-lite output — parsing itself lives
 * in `chat/model/markdown-lite.ts`; this component only paints spans.
 */
export interface ChatRecordProps {
  readonly id: string;
  readonly role: "you" | "agent";
  /**
   * The agent's display name for the `● <agentLabel>` header (M22). `role: "agent"` no longer
   * hardcodes which agent — `Workspace` feeds this from the kernel snapshot's `agentIdentity`,
   * e.g. `"claude"`; an empty string renders the neutral `●` header, never an invented fallback
   * like the design's `codex` sample data. Unused when `role` is `"you"`.
   */
  readonly agentLabel: string;
  readonly lines: readonly import("../model/markdown-lite").MarkdownLine[];
  /** Collapsed/persisted records render dim (design: finished records are P.dim, not green). */
  readonly dim?: boolean;
}

/** One span's resolved foreground + attribute mask against the line's base color. */
interface SpanStyle {
  readonly fg: `#${string}`;
  readonly attrs: number;
}

/**
 * Inline code (design's inline-code accent) always wins the foreground and drops
 * bold regardless of the parser's flags; other spans inherit the line's base color
 * and carry bold/italic straight through.
 */
function spanStyle(span: MarkdownSpan, baseFg: `#${string}`): SpanStyle {
  if (span.code === true) {
    return { fg: SHELL_PALETTE.amberHi, attrs: shellAttrs({ italic: span.italic === true }) };
  }
  return {
    fg: baseFg,
    attrs: shellAttrs({ bold: span.bold === true, italic: span.italic === true }),
  };
}

/**
 * A collapsed, persisted chat record (design §3.2 markdown-lite chat record).
 * Renders the role header — `❯ you` amber bold, or `● <agentLabel>` green bold — followed
 * by one row per already-parsed {@link MarkdownLine}, each row a sequence of styled
 * span runs. Finished records render `dim` (design: `P.dim`, distinct from the
 * ephemeral in-turn record's `P.green`/`P.fg`/`P.faint`, see the phase-7 chat map §2).
 *
 * DIVERGENCE (design sample data, not layout): the design's chat frames (`design/02-workspace-
 * idle.dc.html`, `design/03-workspace-generating.dc.html`) hardcode the agent header as the
 * literal `● codex` — sample data, not layout (user decision 2026-07-23). MVP ships Claude only,
 * so the header text is `agentLabel`, sourced from the kernel snapshot's `agentIdentity` — the
 * glyph (`●`) and green/bold styling stay exactly as designed.
 */
export function ChatRecord(props: ChatRecordProps) {
  const headerText = props.role === "you" ? "❯ you" : `● ${props.agentLabel}`;
  const headerFg = props.role === "you" ? SHELL_PALETTE.amber : SHELL_PALETTE.green;
  const baseFg = props.dim === true ? SHELL_PALETTE.dim : SHELL_PALETTE.fg;

  return (
    <box id={props.id} flexDirection="column">
      <text id={`${props.id}-header`} fg={headerFg} attributes={shellAttrs({ bold: true })}>
        {headerText}
      </text>
      {props.lines.map((line: MarkdownLine, lineIndex) => (
        // keyed intrinsic wrapper — function components carry no `key` in this
        // repo's no-@types/react environment; the row box takes it instead.
        <box key={`line-${lineIndex}`} id={`${props.id}-line-${lineIndex}`} flexDirection="row">
          {line.spans.map((span, spanIndex) => {
            const style = spanStyle(span, baseFg);
            return (
              <text
                key={`span-${spanIndex}`}
                id={`${props.id}-line-${lineIndex}-span-${spanIndex}`}
                fg={style.fg}
                attributes={style.attrs}
              >
                {span.text}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
}

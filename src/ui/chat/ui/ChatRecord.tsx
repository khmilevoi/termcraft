import { DESIGN_DIRNAME } from "entities/design-tree";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { MarkdownLine, MarkdownSpan } from "../model/markdown-lite";

/**
 * One residual Gate warning riding an agent record (WP-11a, `entities/chat`'s
 * `ChatWarningSnapshot` by another name — this file does not import `entities/chat` directly,
 * matching `ChatRecordProps`' own presentation-layer shape rather than a domain/DTO type).
 * `file`/`line` are TREE-relative and optional: an old, pre-Task-11 record carries neither.
 */
export interface ChatWarningRowProps {
  readonly kind: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

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
   * e.g. `"claude"`; an empty string (or an omitted prop) renders the neutral `●` header, never
   * an invented fallback like the design's `codex` sample data. Optional and unused when `role`
   * is `"you"` — `recordToChatRecordProps` (`ChatScrollback.tsx`) only supplies it for
   * `role: "agent"` (review finding Minor, WP-10 fix wave: no unused value riding the props
   * object for a `user` record).
   */
  readonly agentLabel?: string;
  readonly lines: readonly import("../model/markdown-lite").MarkdownLine[];
  /** Collapsed/persisted records render dim (design: finished records are P.dim, not green). */
  readonly dim?: boolean;
  /**
   * Residual Gate warnings this record's turn was accepted carrying (WP-11a,
   * design-agent-feedback-loop repair, Task 11). MEASURED: a turn record persisted four
   * `unguarded-timer` warnings while the agent's own chat message said the timer was fixed —
   * the user had no way to see them, since the agent's prose was the only signal on screen.
   * One row per warning, rendered after the record's own lines, ONLY for `role: "agent"`
   * (`recordToChatRecordProps` never supplies this for a `user` record — same convention as
   * `agentLabel` above). Optional/empty for the overwhelmingly common case (a record with no
   * residual warnings) and for every `user` record.
   */
  readonly warnings?: readonly ChatWarningRowProps[];
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

const DESIGN_TREE_PREFIX = `${DESIGN_DIRNAME}/`;

/**
 * `warning.file` is TREE-relative, matching `GateWarningV1.file`'s own doc — the `design/`
 * prefix is added at DISPLAY time, never persisted. `core/turns/model/prompt.ts`'s
 * `toWorkspacePath` is the ORIGINAL place that prefix gets added (for the agent-facing retry
 * prompt); this is a SECOND, UI-side echo of the identical rule for the chat panel the user
 * reads, not a reuse of that function — `ui` may not import `core/turns` (mirror/DTO boundary,
 * `entities/design-tree`'s `DESIGN_DIRNAME` is the one piece both sides share).
 *
 * Guarded against double-prefixing exactly like `toWorkspacePath`: nothing produces an
 * already-prefixed `file` today, but a silent `design/design/pages/a.tsx` would be a worse
 * failure than this `startsWith` check.
 */
function designTreePath(file: string): string {
  return file.startsWith(DESIGN_TREE_PREFIX) ? file : `${DESIGN_TREE_PREFIX}${file}`;
}

/**
 * One residual warning's display line — the design's OWN vocabulary for a red, ✗-prefixed
 * system line naming a file inside the chat sequence: `wsCancelled`'s scene ends with
 * `{system:'✗ pages/main/page.tsx needs a newer termcraft (kit 2.1)',c:P.red}`
 * (`design/termcraft-engine.js:807`). Reused rather than invented — this is the one place the
 * engine source draws a per-file diagnostic inside `chatSeq`, and residual warnings are exactly
 * that: a per-file (or, when `file` is absent, tree-wide) diagnostic.
 *
 * `file`-less warnings (every record persisted before Task 11, or a genuinely tree-wide Gate
 * warning) render with NO location clause — never a dangling `✗ message in ` with nothing after
 * it, mirroring `core/turns/model/prompt.ts`'s `formatGateWarning`'s identical omission rule.
 */
function formatWarningLine(warning: ChatWarningRowProps): string {
  const location =
    warning.file === undefined
      ? ""
      : ` in ${designTreePath(warning.file)}${warning.line === undefined ? "" : ` line ${warning.line}`}`;
  return `✗ ${warning.message}${location}`;
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
  const headerText = props.role === "you" ? "❯ you" : `● ${props.agentLabel ?? ""}`;
  const headerFg = props.role === "you" ? SHELL_PALETTE.amber : SHELL_PALETTE.green;
  const baseFg = props.dim === true ? SHELL_PALETTE.dim : SHELL_PALETTE.fg;

  return (
    <box id={props.id} flexDirection="column">
      <text id={`${props.id}-header`} fg={headerFg} attributes={shellAttrs({ bold: true })}>
        {headerText}
      </text>
      {props.lines.map((line: MarkdownLine, lineIndex) => (
        // ONE `<text>` per markdown line, spans as `<span>` children — never a
        // `flexDirection="row"` box with one `<text>` per span. A `<text>` is a flex ITEM that
        // word-wraps inside its OWN width (OpenTUI's `wrapMode` defaults to `"word"`), so a row
        // of them turns one paragraph into N independently-wrapping columns: a line reading
        // "Готово — `pages/` активен" rendered as three narrow stacks side by side, with inline
        // code glued into the middle of unrelated words. `<span>` is a text NODE, not a flex
        // item, so the whole line stays a single wrapping flow with per-span styling intact
        // (`TextRenderable.add(TextNodeRenderable)`, `@opentui/react`'s `span: SpanProps`).
        <text
          key={`line-${lineIndex}`}
          id={`${props.id}-line-${lineIndex}`}
          fg={baseFg}
          wrapMode="word"
        >
          {line.spans.map((span, spanIndex) => {
            const style = spanStyle(span, baseFg);
            return (
              <span
                key={`span-${spanIndex}`}
                id={`${props.id}-line-${lineIndex}-span-${spanIndex}`}
                fg={style.fg}
                attributes={style.attrs}
              >
                {span.text}
              </span>
            );
          })}
        </text>
      ))}
      {(props.warnings ?? []).map((warning, warningIndex) => (
        // Stable `id` per row (`gate/model/lints.ts`'s `lintUnpointedElements` warns on a raw
        // element with none, and this project's own UI is subject to the same convention it
        // enforces on authored pages).
        <text
          key={`warning-${warningIndex}`}
          id={`${props.id}-warning-${warningIndex}`}
          fg={SHELL_PALETTE.red}
          wrapMode="word"
        >
          {formatWarningLine(warning)}
        </text>
      ))}
    </box>
  );
}

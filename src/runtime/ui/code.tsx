import { activeSyntaxStyle } from "../model/syntax-style";
import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** Props for the themed `Code` component. `id` is the mandatory stable id (§3.2). */
export interface CodeProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  /** The source text to display, verbatim. Newlines are honoured. */
  readonly content: string;
  /**
   * Which grammar highlights the content — `"typescript"`, `"javascript"`, `"markdown"` or
   * `"zig"`. ANY OTHER VALUE, AND OMITTING IT ENTIRELY, RENDERS PLAIN TEXT: those four (plus
   * `markdown_inline`, used internally by `Markdown`) are the only grammars this binary ships,
   * and termcraft never downloads another one. That is a supported outcome, which is why this
   * is an open string rather than a closed union — a page naming a language this build cannot
   * highlight is correct code, not a type error.
   *
   * Syntax colours come from the ACTIVE THEME, never from a prop.
   */
  readonly language?: string;
}

/**
 * A themed block of source code (design-system §6.1). Renders one OpenTUI `<code>` renderable
 * whose syntax colours are built from the active theme's tokens.
 *
 * WHAT IS DELIBERATELY NOT A PROP. `syntaxStyle` is REQUIRED on OpenTUI's own `CodeOptions`;
 * termcraft constructs it from the theme instead of exposing it, so a page cannot hand the
 * renderer an arbitrary palette. `treeSitterClient` is never exposed at all — it is
 * renderer-internal access, and reaching it is what the wrapper layer exists to prevent.
 *
 * WHY THE ELEMENT'S OWN `fg` IS SET. OpenTUI paints the frame BEFORE highlighting lands (the
 * highlight runs in a worker) using the renderable's own default foreground, whose upstream
 * default is opaque white — not a colour in this design system. Every un-highlighted span, and
 * every span in an unsupported language, draws in this value.
 *
 * WHY `width="100%"`. A code renderable's intrinsic width is its longest line, which clips
 * wrapped content in a column parent. This is the same sizing OpenTUI's own `Markdown` gives
 * the code blocks it creates.
 *
 * FAILURE DEGRADES TO PLAIN TEXT, AS A VALUE. If the native render library cannot allocate a
 * syntax style, `activeSyntaxStyle()` returns an error (it logs once, through
 * `infrastructure/debug-log` — never through `console`, which under the renderer's
 * `consoleMode: "disabled"` writes to the real stdout) and this renders themed plain text.
 */
export function Code(props: CodeProps) {
  const fg = activeTokens().foreground;
  const syntaxStyle = activeSyntaxStyle();
  if (syntaxStyle instanceof Error) return <Text id={props.id}>{props.content}</Text>;

  return (
    <code
      id={props.id}
      content={props.content}
      filetype={props.language}
      syntaxStyle={syntaxStyle}
      fg={fg}
      width="100%"
    />
  );
}

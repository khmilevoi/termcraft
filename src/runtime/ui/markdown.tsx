import { activeSyntaxStyle } from "../model/syntax-style";
import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** Props for the themed `Markdown` component. `id` is the mandatory stable id (§3.2). */
export interface MarkdownProps {
  /** Stable id selection and pins key on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  /**
   * The markdown source. There is NO language prop: a fenced block declares its own language in
   * its info string (```` ```ts ````), and prose is styled by the markdown grammar. Only
   * `typescript`, `javascript`, `markdown` and `zig` fences highlight; any other fence renders
   * plain, which is a supported outcome.
   */
  readonly content: string;
}

/**
 * A themed rendered markdown document (design-system §6.1). Renders one OpenTUI `<markdown>`
 * renderable whose colours — headings, emphasis, lists, links, and every fenced code block —
 * come from the active theme's tokens.
 *
 * NO `filetype` PROP, ON PURPOSE. Language selection is per fenced block, inside the content
 * itself; a document-level language would be meaningless.
 *
 * WHAT IS DELIBERATELY NOT A PROP: `syntaxStyle` (REQUIRED upstream, built here from the theme)
 * and `treeSitterClient` (renderer-internal access this layer exists to prevent).
 *
 * WHY THE ELEMENT'S OWN `fg` IS SET. `MarkdownRenderable` forwards its `fg` to every child code
 * renderable it builds, and those paint their pre-highlight frame with it. Left unset, upstream's
 * own default is opaque white — not a colour in this design system.
 *
 * ASYNCHRONOUS BY CONSTRUCTION, AND WHAT THAT COSTS THE EXPORT PATH. Every block — fenced code
 * AND prose — is internally a code renderable whose highlight runs in a worker, and
 * `MarkdownRenderable` exposes no aggregate completion signal. A single render pass therefore
 * captures the plain-text frame. `RenderHandle.settle()` (`host/render/model/settle.ts`) is what
 * makes a captured markdown frame the finished one; `handleMount` calls it for every mount.
 *
 * FAILURE DEGRADES TO PLAIN TEXT, AS A VALUE — see `Code`'s own note for the mechanism.
 */
export function Markdown(props: MarkdownProps) {
  const fg = activeTokens().foreground;
  const syntaxStyle = activeSyntaxStyle();
  if (syntaxStyle instanceof Error) return <Text id={props.id}>{props.content}</Text>;

  return (
    <markdown
      id={props.id}
      content={props.content}
      syntaxStyle={syntaxStyle}
      fg={fg}
      width="100%"
    />
  );
}

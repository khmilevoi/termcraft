/**
 * Props for {@link TextInput} (finding §2.6): the one shared insertion-point input, used by
 * Home's prompt box and the Workspace composer. The caret run, the value-or-placeholder text,
 * and the cursor cell are drawn here once instead of two divergent per-caller copies.
 */
export interface TextInputProps {
  readonly id: string;
  readonly value: string;
  readonly placeholder: string;
  /** The caret run drawn before the text, e.g. `"❯ "`. */
  readonly caret: string;
  readonly caretFg: `#${string}`;
  readonly valueFg: `#${string}`;
  readonly placeholderFg: `#${string}`;
  /** `false` renders no cursor at all — the design's faint, cursor-less disabled input. */
  readonly showCursor: boolean;
}

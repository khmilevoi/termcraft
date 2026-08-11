import type { TextareaRenderable } from "@opentui/core";

import { isExport } from "../model/capabilities";
import { wrap } from "../model/reatom";
import { activeTokens } from "../model/tokens";

/** Props for the themed `Textarea` component. `id` is the mandatory stable id (§3.2). */
export interface TextareaProps {
  /** Stable id the host answers geometry on and the shell selects/pins. Mandatory. */
  readonly id: string;
  /**
   * The text the editor starts from. UNDER EXPORT this is exactly what renders, on every render
   * (§6.3). In preview it behaves like an HTML `defaultValue` — see the divergence note below.
   */
  readonly value?: string;
  /** Placeholder shown while the buffer is empty. */
  readonly placeholder?: string;
  /** Whether the editor holds keyboard focus. Always false under export (§6.3). */
  readonly focused?: boolean;
  readonly width?: number;
  /** Height in rows. An editor is a viewport, so give it one (or a growing parent). */
  readonly height?: number;
  /** Flex grow factor — a 0 keeps the editor at its height; ≥1 lets it expand. */
  readonly grow?: number;
  /** Soft-wrap mode for long lines. Defaults to `word`. */
  readonly wrap?: "none" | "char" | "word";
  /** Invoked with the whole buffer text on every edit (the intrinsic's `onContentChange`). */
  readonly onChange?: (value: string) => void;
  /** Invoked when the editor's submit binding fires. */
  readonly onSubmit?: () => void;
}

/**
 * Themed multi-line text editor (design-system §3.2, spec §6.1). Renders one OpenTUI
 * `<textarea>` with token-resolved text/placeholder/selection colours, so a theme swap re-colours
 * it without editing sources. A focused editor lifts its body from `background` onto `surface` —
 * the role its own definition calls the "lifted input body" fill; the design ships no screen of
 * an authored page's focused editor, so that is a MAPPING onto existing vocabulary, recorded
 * here rather than invented as a new hue.
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED. `@opentui/core@0.4.5`'s `TextareaOptions`
 * has no `value`; it has `initialValue`, whose setter is a ONE-SHOT LATCH — it applies the first
 * time and ignores every later write. In PREVIEW this wrapper therefore behaves like an HTML
 * `defaultValue`: a `value` change after mount does not re-apply, because keying the element on
 * the text would remount the editor (losing cursor and undo) on every keystroke once the phase-7
 * input path lands. UNDER EXPORT that trade is not available — §6.3 requires the value to come
 * from props rather than internal state — so the element IS keyed on the text there, and a
 * changed `value` produces a fresh instance whose latch fires again.
 *
 * `onChange` reads the buffer through a ref this component owns and never exposes (no
 * passthrough, spec §6): upstream's `ContentChangeEvent` is an EMPTY interface, so the event
 * carries no text and `plainText` off the instance is the only source. It is a CALLBACK ref
 * rather than `useRef` because this repository installs no `@types/react` (see
 * `host/render/model/error-capture.ts`), which makes any `react` import a TS7016.
 */
export function Textarea(props: TextareaProps) {
  const tokens = activeTokens();
  const exporting = isExport();
  const value = props.value ?? "";
  // Per-render slot + per-render callback ref: the callback's identity changes every render, so
  // React re-attaches it on every commit and the handler created in the SAME render always
  // closes over a populated slot.
  const slot: { current: TextareaRenderable | null } = { current: null };
  const attach = (node: TextareaRenderable | null): void => {
    slot.current = node;
  };
  const onChange = props.onChange;
  const onSubmit = props.onSubmit;
  // `wrap` restores the Reatom frame the terminal event loop drops (spec §6, RTM-C02).
  const handleContentChange =
    onChange === undefined
      ? undefined
      : wrap((): void => {
          const node = slot.current;
          if (node === null) return;
          onChange(node.plainText);
        });
  const handleSubmit =
    onSubmit === undefined
      ? undefined
      : wrap((): void => {
          onSubmit();
        });
  return (
    <textarea
      // §6.3's "value taken from props rather than internal state", enforced: under export a
      // changed `value` changes the key, React remounts, and `initialValue`'s one-shot latch
      // fires on the fresh instance. In preview the key is stable so editing survives.
      key={exporting ? `${props.id}:${value}` : props.id}
      id={props.id}
      ref={attach}
      initialValue={value}
      placeholder={props.placeholder}
      width={props.width}
      height={props.height}
      flexGrow={props.grow}
      wrapMode={props.wrap ?? "word"}
      // §6.3: no cursor and no focus under export.
      showCursor={exporting ? false : props.focused === true}
      focused={exporting ? false : props.focused}
      backgroundColor={tokens.background}
      textColor={tokens.foreground}
      focusedBackgroundColor={exporting ? tokens.background : tokens.surface}
      focusedTextColor={tokens.foreground}
      placeholderColor={tokens.foregroundFaint}
      cursorColor={tokens.accent}
      selectionBg={tokens.selection}
      selectionFg={tokens.selectionFg}
      onContentChange={handleContentChange}
      onSubmit={handleSubmit}
    />
  );
}

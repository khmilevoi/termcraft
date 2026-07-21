/** @jsxImportSource @opentui/react */
import { activeTokens } from "../model/tokens";

/** Props for the themed `Input` component. `id` is the mandatory stable id (§3.2). */
export interface InputProps {
  /** Stable id the host selects/pins on (§3.2). Mandatory on every catalog component. */
  readonly id: string;
  /** The current text value. */
  readonly value?: string;
  /** Placeholder shown when the value is empty. */
  readonly placeholder?: string;
  /** Whether the input holds keyboard focus (drives the intrinsic's focused styling). */
  readonly focused?: boolean;
  /** Invoked with the new value on every edit; mapped to the intrinsic's `onInput`. */
  readonly onChange?: (value: string) => void;
}

/**
 * Themed single-line text input (design-system, runtime-api §3.2). Renders a single
 * OpenTUI `<input>` with token-resolved text/placeholder/background colors so a theme
 * swap re-colors it without editing sources. The mandatory `id` flows to the element
 * for the host's geometry queries and the shell's select/pin. `onChange` maps to the
 * intrinsic's `onInput` (fires on each edit) — the interactive path lands in phase 7;
 * in the static headless render the handler is inert. Colors are semantic token names.
 */
export function Input(props: InputProps) {
  const tokens = activeTokens();
  return (
    <input
      id={props.id}
      value={props.value}
      placeholder={props.placeholder}
      focused={props.focused}
      textColor={tokens.foreground}
      placeholderColor={tokens.foregroundFaint}
      backgroundColor={tokens.background}
      onInput={props.onChange}
    />
  );
}

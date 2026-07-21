import { activeTokens } from "../model/tokens";
import { Text } from "./text";

/** Props for the themed `Button` component. `id` is the mandatory stable id (§3.2). */
export interface ButtonProps {
  /** Stable id the host selects/pins on and the shell dispatches presses through (§3.2). */
  readonly id: string;
  /** The button label. */
  readonly children?: string | number;
  /**
   * Invoked when the button is pressed. Accepted here and wired to the box's
   * `onMouseDown` for the interactive path (the shell dispatches it in accepted
   * interactive mode — phase 7); in the static headless render it stays inert.
   */
  readonly onPress?: () => void;
  /** A disabled button renders muted and never fires `onPress`. */
  readonly disabled?: boolean;
}

/**
 * Themed pressable button (design-system, runtime-api §3.2). Renders a bordered
 * OpenTUI `<box>` wrapping a token-colored label `Text`; the mandatory `id` flows
 * to the box so the host can answer geometry queries and the shell can select/pin
 * it. `onPress` is wired to the box's `onMouseDown` handler (the real OpenTUI prop
 * on `RenderableOptions`) for the phase-7 interactive path — disabled buttons pass
 * no handler. Colors are semantic token names, never raw hues.
 */
export function Button(props: ButtonProps) {
  const tokens = activeTokens();
  const disabled = props.disabled === true;
  const onPress = props.onPress;
  const handlePress = disabled || onPress === undefined ? undefined : () => onPress();
  return (
    <box
      id={props.id}
      border
      borderColor={disabled ? tokens.foregroundFaint : tokens.accent}
      padding={0}
      onMouseDown={handlePress}
    >
      <Text id={`${props.id}-label`} color={disabled ? "foregroundFaint" : "foreground"}>
        {props.children}
      </Text>
    </box>
  );
}

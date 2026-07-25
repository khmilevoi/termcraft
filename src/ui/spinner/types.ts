export interface SpinnerProps {
  readonly id: string;
  /** Text rendered after the glyph, e.g. `"generating design…"`. */
  readonly label: string;
  /** Foreground colour — always design-sourced by the caller, never defaulted here. */
  readonly fg: string;
  readonly bold?: boolean;
}

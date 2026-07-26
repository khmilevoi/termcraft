export interface SpinnerProps {
  readonly id: string;
  /** Text rendered after the glyph, e.g. `"generating design…"`. */
  readonly label: string;
  /** Foreground colour — always design-sourced by the caller, never defaulted here. */
  readonly fg: string;
  readonly bold?: boolean;
  /**
   * The turn's `TurnMirror.startedAt`, or `null`/omitted when there is no elapsed time to show
   * (design's own `⠹ generating design… · 2m 40s`, `design/termcraft-engine.js:547`). When
   * present, `Spinner` appends a ` · <elapsed>` segment; when absent, it renders no such segment
   * and never subscribes to the 1s elapsed ticker.
   */
  readonly startedAt?: number | null;
}

import type { ScoredSlashRow } from "ui/actions";

/** Props for the `SlashMenu` popup (design `slashMenu`/`wsSlash`, `design/23-slash-menu.dc.html`). */
export interface SlashMenuProps {
  readonly id: string;
  /** The typed string incl. leading slash, e.g. "/" or "/ch". Title shows "commands" when exactly "/". */
  readonly typed: string;
  /** Rows to render, already filtered+scored by the caller via filterSlashRows(). */
  readonly rows: readonly ScoredSlashRow[];
  /** Index of the highlighted row (caller lands it on the first enabled row). */
  readonly selectedIndex: number;
}

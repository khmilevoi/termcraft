/**
 * `status-bar` — the app shell's bottom status bar (design `statusBar`/`wsStatus`,
 * `design/02-workspace-idle.dc.html`). A plain, props-driven presentation component;
 * this barrel is its public surface.
 */
export type {
  StatusBarHintBadge,
  StatusBarHintKey,
  StatusBarModeChip,
  StatusBarProps,
  StatusBarSegment,
  StatusBarSize,
} from "./types";
export { StatusBar } from "./ui/StatusBar";

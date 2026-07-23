// The single public @termcraft/runtime facade an authored design page imports from
// (runtime-api §3.2). It re-exports the page contract, the Reatom state model, the
// React binding, and the theme token registry under termcraft's own names — the
// private @reatom/*, react, and @opentui/* identities never reach authored source.
// The design-system component catalog, JSX helpers, capabilities, and the low-level
// primitive escape hatch land task-by-task in phase 1.

// Page contract (§4)
export type { PageMeta, Size, ThemeId, ThemeTokens } from "./types";
export { CURRENT_KIT_API_VERSION, definePage } from "./model/define-page";

// Reatom state, async/derivation, and the React binding (§3.2, §5)
export {
  atom,
  computed,
  action,
  wrap,
  withAsync,
  withAsyncData,
  withComputed,
  withAbort,
  withConnectHook,
  reatomComponent,
} from "./model/reatom";
export type {
  Atom,
  Action,
  Computed,
  AtomLike,
  Ext,
  ConnectionCleanup,
  ConnectionHookResult,
} from "./model/reatom";

// Theme token registry (§5.4)
export { themeTokens, DEFAULT_THEME_ID } from "./model/tokens";

// Runtime capabilities (§6): dormant tweaks + host-scoped mode/export + theme +
// navigation (M16) + viewport/terminal-color (M17)
export {
  colorDepthAtom,
  defineTweaks,
  isExport,
  isExportAtom,
  hostModeAtom,
  interactionModeAtom,
  themeCapability,
  usePages,
  viewportSizeAtom,
} from "./model/capabilities";
export type { PagesCapability, ThemeCapability } from "./model/capabilities";

// JSX helper surface (§3.2) + the low-level rendering escape hatch
export { jsx, jsxs, jsxDEV, Fragment } from "./model/jsx";
export { Box } from "./ui/primitive";
export type { BoxProps } from "./ui/primitive";

// Design-system component catalog (§3.2): layout, text, interactive, data widgets.
// Every component carries a mandatory stable `id` (selection/pins key on it).
export { Row } from "./ui/row";
export type { RowProps } from "./ui/row";
export { Column } from "./ui/column";
export type { ColumnProps } from "./ui/column";
export { Panel } from "./ui/panel";
export type { PanelProps } from "./ui/panel";
export { Separator } from "./ui/separator";
export type { SeparatorProps } from "./ui/separator";
export { Spacer } from "./ui/spacer";
export type { SpacerProps } from "./ui/spacer";
export { Text } from "./ui/text";
export type { TextProps } from "./ui/text";
export { Button } from "./ui/button";
export type { ButtonProps } from "./ui/button";
export { Input } from "./ui/input";
export type { InputProps } from "./ui/input";
export { Tabs } from "./ui/tabs";
export type { TabsProps, TabItem } from "./ui/tabs";
export { List } from "./ui/list";
export type { ListProps, ListItem } from "./ui/list";
export { Table } from "./ui/table";
export type { TableProps, TableColumn, TableRow } from "./ui/table";
export { Gauge } from "./ui/gauge";
export type { GaugeProps } from "./ui/gauge";
export { Sparkline } from "./ui/sparkline";
export type { SparklineProps } from "./ui/sparkline";

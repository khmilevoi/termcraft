/**
 * `ui/preview` — the preview region: frame compositing, overlay geometry (pin badges,
 * selection corners), and the empty/error/enlarge panels. Presentation + pure geometry;
 * the workspace reatom-wraps the shell against the mirror and the live `PreviewSession`.
 */
export { colorV1ToInput } from "./model/color";
export type { Point, Rect, SelectionCorners } from "./model/overlay";
export { SELECTION_GLYPHS, pinAnchor, selectionCorners } from "./model/overlay";

export type { FrameViewProps } from "./ui/FrameView";
export { FrameView } from "./ui/FrameView";
export type { EmptyStateProps } from "./ui/EmptyState";
export { EmptyState } from "./ui/EmptyState";
export type { ErrorPanelProps } from "./ui/ErrorPanel";
export { ErrorPanel } from "./ui/ErrorPanel";
export type { EnlargePlaceholderProps, EnlargePlaceholderSize } from "./ui/EnlargePlaceholder";
export { EnlargePlaceholder } from "./ui/EnlargePlaceholder";

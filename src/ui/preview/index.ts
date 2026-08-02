/**
 * `ui/preview` — the preview region: frame compositing, overlay geometry (pin badges,
 * selection corners), and the empty/error/enlarge panels. Presentation + pure geometry;
 * the workspace reatom-wraps the shell against the mirror and the live `PreviewSession`.
 */
export { colorV1ToInput } from "./model/color";
export type {
  GeometryIntent,
  HoverGeometry,
  PendingGeometry,
  PendingPin,
  PreviewInteractionState,
} from "./model/interaction";
export {
  acknowledgeFrame,
  createPreviewInteractionState,
  frameLocalPoint,
  handleGeometryResult,
  requestGeometry,
} from "./model/interaction";
export type { Point, Rect, SelectionCorners } from "./model/overlay";
export { SELECTION_GLYPHS, pinAnchor, selectionCorners } from "./model/overlay";
export { hostFailureCodeOf, isDesignRenderFailure } from "./model/failure-class";
export { hostFailurePhrase } from "./model/host-failure-phrase";
export type { RepairPromptInput } from "./model/repair-prompt";
export { buildRepairPrompt, relativePageSourcePath } from "./model/repair-prompt";

export type { FrameViewProps } from "./ui/FrameView";
export { FrameView } from "./ui/FrameView";
export type { PreviewOverlaysProps } from "./ui/PreviewOverlays";
export { PreviewOverlays } from "./ui/PreviewOverlays";
export type { EmptyStateProps } from "./ui/EmptyState";
export { EmptyState } from "./ui/EmptyState";
export type { OpeningStateProps } from "./ui/OpeningState";
export { OpeningState } from "./ui/OpeningState";
export type { ErrorPanelProps } from "./ui/ErrorPanel";
export { ErrorPanel } from "./ui/ErrorPanel";
export type { HostCrashPanelProps } from "./ui/HostCrashPanel";
export { HostCrashPanel } from "./ui/HostCrashPanel";
export type { HostUnavailablePanelProps } from "./ui/HostUnavailablePanel";
export { HostUnavailablePanel } from "./ui/HostUnavailablePanel";
export type { EnlargePlaceholderProps, EnlargePlaceholderSize } from "./ui/EnlargePlaceholder";
export { EnlargePlaceholder } from "./ui/EnlargePlaceholder";

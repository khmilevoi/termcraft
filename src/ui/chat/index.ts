/**
 * `ui/chat` — the chat panel's parts: the markdown-lite parser, the ephemeral agent status
 * block, a collapsed chat record, and the composer. Presentation components are props-driven;
 * the workspace reatom-wraps them against the mirror.
 */
export type { MarkdownLine, MarkdownSpan } from "./model/markdown-lite";
export { flattenMarkdownLite, parseInline } from "./model/markdown-lite";

export type { AgentGateRetry, AgentStatusBlockProps } from "./ui/AgentStatusBlock";
export { AgentStatusBlock } from "./ui/AgentStatusBlock";
export type { RenderedTimelineEntry, TimelineFold } from "./model/turn-timeline";
export { foldTurnTimeline, wrapText } from "./model/turn-timeline";
export { markdownLineRows, renderedRowCount } from "./model/text-rows";
export type { ComposerProps } from "./ui/Composer";
export { Composer } from "./ui/Composer";
export type { ChatRecordProps } from "./ui/ChatRecord";
export { ChatRecord } from "./ui/ChatRecord";
export type { ChatOlderPageState, ChatScrollbackProps } from "./ui/ChatScrollback";
export { ChatScrollback, recordToChatRecordProps } from "./ui/ChatScrollback";
export type { PinListProps, PinListRow } from "./ui/PinList";
export { PinList } from "./ui/PinList";
export type { SystemNoticeProps } from "./ui/SystemNotice";
export { SystemNotice } from "./ui/SystemNotice";

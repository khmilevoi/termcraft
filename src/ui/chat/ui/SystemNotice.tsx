import { SHELL_PALETTE } from "ui/theme";

/** Props for the {@link SystemNotice} ephemeral chat line pair. */
export interface SystemNoticeProps {
  /** Stable id the host selects and answers geometry on. */
  readonly id: string;
  /** The red first line — what happened. */
  readonly headline: string;
  /** The faint second line — the fact that qualifies it. */
  readonly detail: string;
}

/**
 * A two-line, UI-local system notice in the chat panel (design `wsHostCrash`'s `chatSeq` system
 * entries: a `P.red` line followed by a `P.faint` one, both in the `⟲ system-entry` register §12's
 * intro names).
 *
 * NOT a `ChatRecord`. `ChatRecord` renders PERSISTED history — rows the chat store owns and
 * replays. This renders a live condition the mirror holds and drops again (`Mirror.previewNotice`),
 * which is why it has no role header, no timestamp and no id from the store.
 */
export function SystemNotice(props: SystemNoticeProps) {
  return (
    <box id={props.id} flexDirection="column">
      {/* `wrapMode="word"` for the same reason `ChatRecord`'s own lines carry it: the chat panel
          is roughly a third of the terminal, and both sentences are longer than that at any
          ordinary width. Unwrapped they would be silently clipped mid-word. */}
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.red} wrapMode="word">
        {props.headline}
      </text>
      <text id={`${props.id}-detail`} fg={SHELL_PALETTE.faint} wrapMode="word">
        {props.detail}
      </text>
    </box>
  );
}

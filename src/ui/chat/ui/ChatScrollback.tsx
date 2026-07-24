import type { ChatRecord as ChatRecordDto } from "ui/mirror";

import { flattenMarkdownLite } from "../model/markdown-lite";
import { ChatRecord, type ChatRecordProps } from "./ChatRecord";

/**
 * Design-sourced display text for one persisted record (design §3.2). `user`/`agent`/
 * `system:error`/`system:cancelled` records already carry their own display `text`.
 * `system:restore` does NOT — it is defined on the wire only for reader completeness/
 * forward-compat (`entities/chat/types.ts:76-81`: "Restore is OUT OF MVP SCOPE… no phase-4
 * code path writes this record, so it cannot legitimately appear in an MVP-created chat");
 * this branch is therefore unreachable with any real MVP data. It composes the design's own
 * literal restore-record format (`⟲ restored <page> from <commit>`,
 * `design/termcraft-engine.js:995`, `wsRestoreApplied`) from the record's real fields, using
 * the full `sourceCommit` id as-is — no spec or engine source defines a short-hash display
 * convention, so one is not invented here.
 */
function recordText(record: ChatRecordDto): string {
  switch (record.kind) {
    case "user":
    case "agent":
    case "system:error":
    case "system:cancelled":
      return record.text;
    case "system:restore":
      return `⟲ restored ${record.pageSlug} from ${record.sourceCommit}`;
  }
}

/**
 * Maps one persisted `ChatRecordDtoV1` (`ui/mirror`'s `ChatRecord`) to {@link ChatRecordProps}.
 * This is the ONE mapping the M11 handoff names (`docs/superpowers/plans/
 * 2026-07-24-chat-transport.md` Task 8): WP-9 Task 8 must feed the just-completed turn's
 * message through this SAME function rather than build a parallel `finalText` render, so the
 * ephemeral and persisted paths never diverge.
 *
 * `role` is `"you"` only for a `user` record — every other kind (`agent`, both system kinds,
 * and the reader-only `system:restore`) renders through the agent-role header, matching the
 * design engine's own `chatSeq` split (`e.role[0]==='❯' ? P.amber : P.green`,
 * `design/termcraft-engine.js:432`). `dim: true` always — persisted/collapsed records render
 * dim, distinct from the ephemeral in-turn block's `P.green`/`P.fg`/`P.faint`
 * (`ChatRecord.tsx:21-22`). `id` is derived from `recordId` so the same record always maps to
 * the same component id, which is what lets WP-9 Task 8's interim record and this package's
 * real persisted record agree once they converge.
 */
export function recordToChatRecordProps(
  record: ChatRecordDto,
  agentLabel: string,
): ChatRecordProps {
  return {
    id: `chat-record-${record.recordId}`,
    role: record.kind === "user" ? "you" : "agent",
    agentLabel,
    lines: flattenMarkdownLite(recordText(record)),
    dim: true,
  };
}

/** Props for {@link ChatScrollback}. `id` is the mandatory stable id (§3.2). */
export interface ChatScrollbackProps {
  readonly id: string;
  /** The active chat's persisted tail, in arrival order (`Mirror.records`, WP-10 Task 7). */
  readonly records: readonly ChatRecordDto[];
  /** The agent's display name for every agent-role header (M22) — see `ChatRecordProps.agentLabel`. */
  readonly agentLabel: string;
}

/**
 * The persisted chat scrollback (design §3.2, `spec:149-160`: "the block collapses into the
 * persisted agent record… above"; `design/03-workspace-generating.dc.html`,
 * `design/14-first-generation.dc.html`). Renders the active chat's tail as a column of
 * {@link ChatRecord}s in arrival order — the caller (`Workspace.tsx`) places this ABOVE the
 * ephemeral `AgentStatusBlock`/collapsed-turn `ChatRecord`. Adds no new visual vocabulary of
 * its own; every glyph/color comes from `ChatRecord`.
 */
export function ChatScrollback(props: ChatScrollbackProps) {
  if (props.records.length === 0) return null;
  return (
    <box id={props.id} flexDirection="column">
      {props.records.map((record) => {
        const recordProps = recordToChatRecordProps(record, props.agentLabel);
        return (
          // keyed intrinsic wrapper — function components carry no `key` in this repo's
          // no-@types/react environment (`runtime/ui/list.tsx`).
          <box key={record.recordId} id={`${recordProps.id}-wrap`}>
            <ChatRecord {...recordProps} />
          </box>
        );
      })}
    </box>
  );
}

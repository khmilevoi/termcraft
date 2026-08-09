import type { MouseEvent } from "@opentui/core";

import type { ChatRecord as ChatRecordDto } from "ui/mirror";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { flattenMarkdownLite } from "../model/markdown-lite";
import { ChatRecord, type ChatRecordProps } from "./ChatRecord";

/** The design engine's own restore-record sample data (`design/termcraft-engine.js:995`, `wsRestoreApplied`: `"⟲ restored main from a1b2c3d"`) uses a 7-char short hash, not the full commit id — the one display convention the engine actually defines for this field. */
const RESTORE_SOURCE_COMMIT_DISPLAY_LENGTH = 7;

/**
 * Design-sourced display text for one persisted record (design §3.2). `user`/`agent`/
 * `system:error`/`system:cancelled` records already carry their own display `text`.
 * `system:restore` does NOT — it is defined on the wire only for reader completeness/
 * forward-compat (`entities/chat/types.ts:76-81`: "Restore is OUT OF MVP SCOPE… no phase-4
 * code path writes this record, so it cannot legitimately appear in an MVP-created chat");
 * this branch is therefore unreachable with any real MVP data. It composes the design's own
 * literal restore-record format (`⟲ restored <page> from <commit>`,
 * `design/termcraft-engine.js:995`, `wsRestoreApplied`) from the record's real fields,
 * truncating `sourceCommit` to the engine's own 7-char short-hash sample (`"a1b2c3d"`) —
 * the full id is never displayed, matching the one hash-display convention the engine
 * source actually shows (review finding Minor, WP-10 fix wave).
 */
function recordText(record: ChatRecordDto): string {
  switch (record.kind) {
    case "user":
    case "agent":
    case "system:error":
    case "system:cancelled":
      return record.text;
    case "system:restore":
      return `⟲ restored ${record.pageSlug} from ${record.sourceCommit.slice(0, RESTORE_SOURCE_COMMIT_DISPLAY_LENGTH)}`;
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
 *
 * `agentLabel` is included ONLY for `role: "agent"` (review finding Minor, WP-10 fix wave):
 * `ChatRecord`'s own header render ignores it entirely for `role: "you"`
 * (`ChatRecord.tsx`'s `headerText`), so carrying it through for a `user` record would just be
 * an unused value riding the props object — omitting it there is a shape tightening, not a
 * behavior change.
 */
export function recordToChatRecordProps(
  record: ChatRecordDto,
  agentLabel: string,
): ChatRecordProps {
  const role = record.kind === "user" ? "you" : "agent";
  return {
    id: `chat-record-${record.recordId}`,
    role,
    ...(role === "agent" ? { agentLabel } : {}),
    lines: flattenMarkdownLite(recordText(record)),
    dim: true,
    // Residual Gate warnings (WP-11a, Task 11) — ONLY an `agent` record carries any
    // (`ChatAgentRecordDtoV1.warnings`, `core/protocol`). `file`/`line` come off the wire as
    // `| null` (this DTO's own "never omission" rule); `ChatRecordProps` is a presentation-layer
    // shape that uses `undefined`-based optionals like `agentLabel`/`dim` above, so `null` is
    // normalized to `undefined` here rather than threading the wire's own convention past this
    // mapping boundary.
    ...(record.kind === "agent"
      ? {
          warnings: record.warnings.map((w) => ({
            kind: w.kind,
            message: w.message,
            file: w.file ?? undefined,
            line: w.line ?? undefined,
          })),
        }
      : {}),
  };
}

/**
 * Whether an older page of this chat's history is being loaded right now, and whether the last
 * attempt failed (chat-scroll spec §6.6). UI-local: the operation does not complete when the
 * dispatch promise resolves — it completes when `chat.records.older` arrives — so this is a
 * plain latch, not a `withAsync` state (spec §6.6 states the reason at length).
 *
 * `safeMessage` is the failure's own bounded message, never a path or an environment value.
 */
export type ChatOlderPageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly safeMessage: string };

/** Props for {@link ChatScrollback}. `id` is the mandatory stable id (§3.2). */
export interface ChatScrollbackProps {
  readonly id: string;
  /** The active chat's persisted tail, in arrival order (`Mirror.records`, WP-10 Task 7). */
  readonly records: readonly ChatRecordDto[];
  /** The agent's display name for every agent-role header (M22) — see `ChatRecordProps.agentLabel`. */
  readonly agentLabel: string;
  /** The inner text width records wrap against — the panel's own content width. */
  readonly width: number;
  /**
   * Records the client has NOT loaded: total minus loaded, never negative (chat-scroll spec
   * §5.4). This is the number the `▲ N earlier messages` row names — a page-load count, not a
   * scroll-position estimate. The `<scrollbox>` the caller mounts this component inside now
   * owns clipping, so this component never derives a count from how much of `records` is
   * actually on screen.
   */
  readonly unloadedCount: number;
  /**
   * True once the chat's first record is in the loaded window (`prevCursor === null`,
   * chat-scroll spec §5.4). Drives the `╌╌╌ start of chat ╌╌╌` marker below the indicator row
   * and — combined with `olderPage` — whether the indicator row renders at all.
   */
  readonly atStart: boolean;
  /** The older-page load latch (spec §6.6) — see {@link ChatOlderPageState} above. */
  readonly olderPage: ChatOlderPageState;
  /**
   * Fired when the user clicks the indicator row to request the next older page. Optional:
   * wiring the actual paging trigger is Task 12's job, not this component's.
   */
  readonly onLoadOlder?: (event: MouseEvent) => void;
}

/**
 * Design iteration 10, answer 1 (`design/termcraft-engine.js:1502`): the "more" state's own
 * label. The design's literal is `'▲ '+top.n+' earlier messages'` with no singular branch —
 * unlike the row-budget indicator this component used to render (which pluralized locally),
 * the design never does, so this doesn't either.
 */
function earlierMessagesText(count: number): string {
  return `▲ ${count} earlier messages`;
}

/**
 * Design iteration 10, answer 1 (`design/termcraft-engine.js:1502-1503`): the indicator row's
 * foreground, both the label and the right-edge `▲` mark (`this.put(b,maxX,y,'▲',{fg:P.amberDim})`).
 */
const INDICATOR_FG = SHELL_PALETTE.amberDim;

/**
 * Design iteration 10, answer 4 (`design/termcraft-engine.js:1504`): the "loading" state's own
 * label, exported so the test asserts the design's own literal rather than restating it.
 */
export const OLDER_LOADING_TEXT = "⠹ loading earlier messages…";

/** Design iteration 10, answer 4 (`design/termcraft-engine.js:1505`): the failed state's message-row foreground. */
const OLDER_FAILED_FG = SHELL_PALETTE.red;

/**
 * Design iteration 10, answer 4 (`design/termcraft-engine.js:1506`): the failed state's fixed
 * second line — always this exact text, regardless of the failure's own message above it.
 */
const OLDER_RETRY_TEXT = "PgUp retries";

/**
 * Design iteration 10, answer 4 (`design/termcraft-engine.js:1506`): the failed state's
 * second-line foreground — faint, and (unlike the message row above it) NOT bold.
 */
const OLDER_RETRY_FG = SHELL_PALETTE.faint;

/** Design iteration 10, answer 5 (`design/termcraft-engine.js:1507`): the chat-start marker's own literal, centered. */
export const CHAT_START_TEXT = "╌╌╌ start of chat ╌╌╌";

/** Design iteration 10, answer 5 (`design/termcraft-engine.js:1507`): the chat-start marker's foreground — faint, NOT bold. */
const CHAT_START_FG = SHELL_PALETTE.faint;

/**
 * The indicator row's content, one of three states latched by `olderPage` (spec §6.6):
 *
 * - "more" (idle, not at start): the reachable page-load target — the label plus a second,
 *   right-edge `▲` mark (design/termcraft-engine.js:1502-1503's `ctext` + `put` pair).
 * - "loading": the label alone, no right-edge mark — the design draws no `put` for this mode
 *   (`:1504`).
 * - "failed": TWO separate rows, not one string — the bounded message (red, bold) then the
 *   fixed `PgUp retries` hint (faint, not bold) beneath it, matching the design's own two
 *   `ctext` calls (`:1505-1506`) rather than folding both into a single line.
 *
 * The whole row is the click target for `onLoadOlder` in every state — Task 12 decides which
 * states actually wire a handler; this component only exposes the surface.
 */
function renderIndicator(props: ChatScrollbackProps) {
  const id = props.id;
  if (props.olderPage.kind === "loading") {
    return (
      <box id={`${id}-earlier`} width={props.width} onMouseDown={props.onLoadOlder}>
        <text id={`${id}-earlier-label`} fg={INDICATOR_FG} attributes={shellAttrs({ bold: true })}>
          {OLDER_LOADING_TEXT}
        </text>
      </box>
    );
  }
  if (props.olderPage.kind === "failed") {
    return (
      <box
        id={`${id}-earlier`}
        flexDirection="column"
        width={props.width}
        onMouseDown={props.onLoadOlder}
      >
        <text
          id={`${id}-earlier-label`}
          fg={OLDER_FAILED_FG}
          attributes={shellAttrs({ bold: true })}
        >
          {`✗ ${props.olderPage.safeMessage}`}
        </text>
        <text id={`${id}-earlier-retry`} fg={OLDER_RETRY_FG}>
          {OLDER_RETRY_TEXT}
        </text>
      </box>
    );
  }
  // Neither "loading" nor "failed" and `showIndicator` is true (below), so `olderPage.kind` is
  // "idle" and `atStart` is false — the design's "more" mode.
  return (
    <box
      id={`${id}-earlier`}
      flexDirection="row"
      justifyContent="space-between"
      width={props.width}
      onMouseDown={props.onLoadOlder}
    >
      <text id={`${id}-earlier-label`} fg={INDICATOR_FG} attributes={shellAttrs({ bold: true })}>
        {earlierMessagesText(props.unloadedCount)}
      </text>
      <text id={`${id}-earlier-mark`} fg={INDICATOR_FG}>
        {"▲"}
      </text>
    </box>
  );
}

/**
 * The persisted chat scrollback (design §3.2). A plain column of {@link ChatRecord}s over
 * EVERY loaded record, in arrival order — the row budget this component used to enforce is
 * gone, because the `<scrollbox>` the caller mounts it inside now clips (chat-scroll spec
 * §5.2). `Workspace.tsx` places this above the ephemeral `AgentStatusBlock`/collapsed record.
 *
 * The `▲ N earlier` row is CONTENT, not an overlay, and `N` counts records the client has not
 * loaded (§5.4) — never records scrolled above the viewport edge. That number is derivable
 * but is deliberately never computed: keeping it out means this component never reads a
 * scroll metric, and the row is simply what the user scrolls to and what triggers the next
 * page load. Adds no visual vocabulary of its own beyond the literals design iteration 10
 * defines above.
 */
export function ChatScrollback(props: ChatScrollbackProps) {
  const showIndicator = !props.atStart || props.olderPage.kind !== "idle";
  if (props.records.length === 0 && !showIndicator) return null;

  return (
    <box id={props.id} flexDirection="column">
      {showIndicator && renderIndicator(props)}
      {props.atStart && (
        <box
          id={`${props.id}-start`}
          width={props.width}
          flexDirection="row"
          justifyContent="center"
        >
          <text id={`${props.id}-start-label`} fg={CHAT_START_FG}>
            {CHAT_START_TEXT}
          </text>
        </box>
      )}
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

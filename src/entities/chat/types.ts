import type { PageSlug } from "../page"

/** First line of every chat JSONL (storage-identity §11.2). */
export interface ChatHeader {
  readonly kind: "chat"
  readonly formatVersion: 1
  readonly projectId: string
  readonly chatId: string
  readonly createdAt: string // UTC RFC 3339
}

/** A resolved element selection sent with a user message (turn-durability §6.1). */
export interface ChatSelection {
  readonly pageSlug: PageSlug
  readonly element: string
}

/**
 * A gate-warning snapshot stored on an agent record. IMMUTABLE historical
 * presentation (projections §6.2) — never the source of current diagnostics.
 * Decoupled from gate's `GateWarning` because `entities/` imports no adapter.
 */
export interface ChatWarningSnapshot {
  readonly kind: string
  readonly message: string
}

/** The initiating record of a turn (storage-identity §11.2; turn-durability §6.1). */
export interface ChatUserRecord {
  readonly kind: "user"
  readonly recordId: string
  readonly turnId: string
  readonly text: string
  readonly selection?: ChatSelection
  readonly pins?: readonly string[] // included pinId references
  readonly ts: string
}

/** The successful terminal record of a turn (storage-identity §11.2; turn-durability §6.1/§7.4). */
export interface ChatAgentRecord {
  readonly kind: "agent"
  readonly recordId: string
  readonly turnId: string
  readonly text: string
  readonly changedPages: readonly PageSlug[]
  readonly warnings: readonly ChatWarningSnapshot[]
  readonly ts: string
}

/**
 * Terminal failure/interruption record (storage-identity §11.2; turn-durability
 * §6.1/§7.6). `turnId`/`actionId` are mutually exclusive (decoder-enforced): a turn
 * failure carries `turnId`; a standalone action failure carries `actionId`.
 */
export interface ChatSystemErrorRecord {
  readonly kind: "system:error"
  readonly recordId: string
  readonly turnId?: string
  readonly actionId?: string
  readonly outcome: "error" | "stale" | "interrupted"
  readonly reason?: string // e.g. "process_restart_before_intent"
  readonly text: string
  readonly ts: string
}

/** Terminal cancellation record (storage-identity §11.2; turn-durability §6.1). */
export interface ChatSystemCancelledRecord {
  readonly kind: "system:cancelled"
  readonly recordId: string
  readonly turnId?: string // exactly one of turnId/actionId (decoder-enforced)
  readonly actionId?: string
  readonly text: string
  readonly ts: string
}

/**
 * Restore audit record (storage-identity §11.2). DEFINED for reader completeness and
 * forward-compat, but Restore is OUT OF MVP SCOPE (roadmap Out-of-scope): no phase-4
 * code path writes this record, so it cannot legitimately appear in an MVP-created
 * chat. The decoder recognizes and validates it; no writer exists.
 */
export interface ChatSystemRestoreRecord {
  readonly kind: "system:restore"
  readonly recordId: string
  readonly restoreActionId: string
  readonly pageSlug: PageSlug
  readonly sourceCommit: string // full Git object id
  readonly ts: string
}

/** Any record line after a chat header (storage-identity §11.2). */
export type ChatRecord =
  | ChatUserRecord
  | ChatAgentRecord
  | ChatSystemErrorRecord
  | ChatSystemCancelledRecord
  | ChatSystemRestoreRecord

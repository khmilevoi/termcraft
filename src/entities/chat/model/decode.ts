import * as errore from "errore"

import { isRfc3339Utc } from "infrastructure/clock"
import { isCanonicalUuidv7 } from "infrastructure/uuid"
import { parsePageSlug } from "entities/page"
import type { PageSlug } from "entities/page"
import type {
  ChatAgentRecord,
  ChatHeader,
  ChatRecord,
  ChatSelection,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
  ChatWarningSnapshot,
} from "../types"

/**
 * A schema or identity violation in a chat header/record (storage-identity §11.1/§11.2).
 * Decoders return this as a value — a corrupt record is data, not an exception. Unknown
 * extra fields are IGNORED (forward-compatible), matching "readers do not assign meaning
 * to key order" (§11.1).
 */
export class ChatDecodeError extends errore.createTaggedError({
  name: "ChatDecodeError",
  message: "chat decode failed [$code]: $reason",
}) {}

type Obj = Record<string, unknown>

function fail(code: string, reason: string): ChatDecodeError {
  return new ChatDecodeError({ code, reason })
}

function asObject(value: unknown): Obj | ChatDecodeError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("SHAPE", "record is not a JSON object")
  return value as Obj
}

function reqString(obj: Obj, key: string): string | ChatDecodeError {
  const v = obj[key]
  if (typeof v !== "string" || v.length === 0) return fail("FIELD", `\`${key}\` must be a non-empty string`)
  return v
}

function reqUuid(obj: Obj, key: string): string | ChatDecodeError {
  const v = reqString(obj, key)
  if (v instanceof Error) return v
  if (!isCanonicalUuidv7(v)) return fail("IDENTITY", `\`${key}\` is not a canonical UUIDv7`)
  return v
}

function reqTs(obj: Obj): string | ChatDecodeError {
  const v = reqString(obj, "ts")
  if (v instanceof Error) return v
  if (!isRfc3339Utc(v)) return fail("TIMESTAMP", "`ts` is not a UTC RFC 3339 timestamp")
  return v
}

function reqSlug(value: unknown, where: string): PageSlug | ChatDecodeError {
  if (typeof value !== "string") return fail("FIELD", `${where} must be a slug string`)
  const slug = parsePageSlug(value)
  if (slug instanceof Error) return fail("IDENTITY", `${where}: ${slug.message}`)
  return slug
}

/** Read the two common record fields every non-header record carries. */
function common(obj: Obj): { recordId: string; ts: string } | ChatDecodeError {
  const recordId = reqUuid(obj, "recordId")
  if (recordId instanceof Error) return recordId
  const ts = reqTs(obj)
  if (ts instanceof Error) return ts
  return { recordId, ts }
}

/**
 * Read a mutually-exclusive `turnId`/`actionId` pair (storage-identity §11.2: a
 * `system:*` record relates to exactly one of a turn or a standalone action).
 */
function xorTurnAction(obj: Obj): { turnId?: string; actionId?: string } | ChatDecodeError {
  const hasTurn = obj["turnId"] !== undefined
  const hasAction = obj["actionId"] !== undefined
  if (hasTurn === hasAction) return fail("IDENTITY", "exactly one of `turnId`/`actionId` is required")
  if (hasTurn) {
    const turnId = reqUuid(obj, "turnId")
    if (turnId instanceof Error) return turnId
    return { turnId }
  }
  const actionId = reqUuid(obj, "actionId")
  if (actionId instanceof Error) return actionId
  return { actionId }
}

function decodeSelection(value: unknown): ChatSelection | ChatDecodeError {
  const obj = asObject(value)
  if (obj instanceof Error) return fail("FIELD", "`selection` must be an object")
  const pageSlug = reqSlug(obj["pageSlug"], "`selection.pageSlug`")
  if (pageSlug instanceof Error) return pageSlug
  const element = reqString(obj, "element")
  if (element instanceof Error) return fail("FIELD", "`selection.element` must be a non-empty string")
  return { pageSlug, element }
}

function decodePins(value: unknown): readonly string[] | ChatDecodeError {
  if (!Array.isArray(value)) return fail("FIELD", "`pins` must be an array")
  const pins: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !isCanonicalUuidv7(entry)) return fail("IDENTITY", "each `pins` entry must be a UUIDv7 pinId")
    pins.push(entry)
  }
  return pins
}

function decodeChangedPages(value: unknown): readonly PageSlug[] | ChatDecodeError {
  if (!Array.isArray(value)) return fail("FIELD", "`changedPages` must be an array")
  const slugs: PageSlug[] = []
  for (const entry of value) {
    const slug = reqSlug(entry, "`changedPages` entry")
    if (slug instanceof Error) return slug
    slugs.push(slug)
  }
  return slugs
}

function decodeWarnings(value: unknown): readonly ChatWarningSnapshot[] | ChatDecodeError {
  if (!Array.isArray(value)) return fail("FIELD", "`warnings` must be an array")
  const warnings: ChatWarningSnapshot[] = []
  for (const entry of value) {
    const obj = asObject(entry)
    if (obj instanceof Error) return fail("FIELD", "each `warnings` entry must be an object")
    const kind = reqString(obj, "kind")
    if (kind instanceof Error) return kind
    const message = reqString(obj, "message")
    if (message instanceof Error) return message
    warnings.push({ kind, message })
  }
  return warnings
}

function decodeUser(obj: Obj, base: { recordId: string; ts: string }): ChatUserRecord | ChatDecodeError {
  const turnId = reqUuid(obj, "turnId")
  if (turnId instanceof Error) return turnId
  const text = reqString(obj, "text")
  if (text instanceof Error) return text
  const record: {
    kind: "user"
    recordId: string
    turnId: string
    text: string
    ts: string
    selection?: ChatSelection
    pins?: readonly string[]
  } = { kind: "user", recordId: base.recordId, turnId, text, ts: base.ts }
  if (obj["selection"] !== undefined) {
    const selection = decodeSelection(obj["selection"])
    if (selection instanceof Error) return selection
    record.selection = selection
  }
  if (obj["pins"] !== undefined) {
    const pins = decodePins(obj["pins"])
    if (pins instanceof Error) return pins
    record.pins = pins
  }
  return record
}

function decodeAgent(obj: Obj, base: { recordId: string; ts: string }): ChatAgentRecord | ChatDecodeError {
  const turnId = reqUuid(obj, "turnId")
  if (turnId instanceof Error) return turnId
  const text = reqString(obj, "text")
  if (text instanceof Error) return text
  const changedPages = decodeChangedPages(obj["changedPages"])
  if (changedPages instanceof Error) return changedPages
  const warnings = decodeWarnings(obj["warnings"])
  if (warnings instanceof Error) return warnings
  return { kind: "agent", recordId: base.recordId, turnId, text, changedPages, warnings, ts: base.ts }
}

const ERROR_OUTCOMES = new Set(["error", "stale", "interrupted"])

function decodeSystemError(obj: Obj, base: { recordId: string; ts: string }): ChatSystemErrorRecord | ChatDecodeError {
  const ids = xorTurnAction(obj)
  if (ids instanceof Error) return ids
  const outcome = obj["outcome"]
  if (typeof outcome !== "string" || !ERROR_OUTCOMES.has(outcome)) return fail("FIELD", "`outcome` must be one of error/stale/interrupted")
  const text = reqString(obj, "text")
  if (text instanceof Error) return text
  const record: ChatSystemErrorRecord = {
    kind: "system:error",
    recordId: base.recordId,
    outcome: outcome as ChatSystemErrorRecord["outcome"],
    text,
    ts: base.ts,
    ...ids,
  }
  if (obj["reason"] !== undefined) {
    const reason = reqString(obj, "reason")
    if (reason instanceof Error) return reason
    return { ...record, reason }
  }
  return record
}

function decodeSystemCancelled(obj: Obj, base: { recordId: string; ts: string }): ChatSystemCancelledRecord | ChatDecodeError {
  const ids = xorTurnAction(obj)
  if (ids instanceof Error) return ids
  const text = reqString(obj, "text")
  if (text instanceof Error) return text
  return { kind: "system:cancelled", recordId: base.recordId, text, ts: base.ts, ...ids }
}

function decodeSystemRestore(obj: Obj, base: { recordId: string; ts: string }): ChatSystemRestoreRecord | ChatDecodeError {
  const restoreActionId = reqUuid(obj, "restoreActionId")
  if (restoreActionId instanceof Error) return restoreActionId
  const pageSlug = reqSlug(obj["pageSlug"], "`pageSlug`")
  if (pageSlug instanceof Error) return pageSlug
  const sourceCommit = reqString(obj, "sourceCommit")
  if (sourceCommit instanceof Error) return sourceCommit
  return { kind: "system:restore", recordId: base.recordId, restoreActionId, pageSlug, sourceCommit, ts: base.ts }
}

/**
 * Decode a chat JSONL header line (storage-identity §11.2): `kind = "chat"`,
 * `formatVersion = 1`, and canonical `projectId`/`chatId`/`createdAt` identities.
 */
export function decodeChatHeader(value: unknown): ChatHeader | ChatDecodeError {
  const obj = asObject(value)
  if (obj instanceof Error) return obj
  if (obj["kind"] !== "chat") return fail("KIND", "header `kind` must be \"chat\"")
  if (obj["formatVersion"] !== 1) return fail("VERSION", "header `formatVersion` must be 1")
  const projectId = reqUuid(obj, "projectId")
  if (projectId instanceof Error) return projectId
  const chatId = reqUuid(obj, "chatId")
  if (chatId instanceof Error) return chatId
  const createdAt = reqString(obj, "createdAt")
  if (createdAt instanceof Error) return createdAt
  if (!isRfc3339Utc(createdAt)) return fail("TIMESTAMP", "`createdAt` is not a UTC RFC 3339 timestamp")
  return { kind: "chat", formatVersion: 1, projectId, chatId, createdAt }
}

/**
 * Decode one chat record line by its `kind` (storage-identity §11.2), validating the
 * schema and every identity/timestamp. An unknown `kind` or any invalid field is a
 * `ChatDecodeError`; extra fields are ignored (forward-compatible). The streaming
 * reader/1-MiB-bound and file-order rules live in `store/jsonl`, not here.
 */
export function decodeChatRecord(value: unknown): ChatRecord | ChatDecodeError {
  const obj = asObject(value)
  if (obj instanceof Error) return obj
  const base = common(obj)
  if (base instanceof Error) return base
  switch (obj["kind"]) {
    case "user":
      return decodeUser(obj, base)
    case "agent":
      return decodeAgent(obj, base)
    case "system:error":
      return decodeSystemError(obj, base)
    case "system:cancelled":
      return decodeSystemCancelled(obj, base)
    case "system:restore":
      return decodeSystemRestore(obj, base)
    default:
      return fail("KIND", `unknown record kind ${JSON.stringify(obj["kind"])}`)
  }
}

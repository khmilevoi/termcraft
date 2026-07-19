import { encodeFrame } from "infrastructure/framing"
import type { ControlEnvelope } from "../types"
import { ProtocolError } from "./errors"
import {
  asObject,
  asString,
  expectExactKeys,
  isDecimalUint64String,
  isLowercaseHex,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"

const KIND_MAX = 64
const SESSION_ID_MAX = 64
const NONCE_HEX_LENGTH = 32

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function encodeControlEnvelope(
  envelope: ControlEnvelope,
): ProtocolError | Uint8Array {
  // Omit the optional id fields when absent so they never serialize as null.
  const wire: Record<string, unknown> = {
    protocolVersion: envelope.protocolVersion,
    kind: envelope.kind,
    sessionId: envelope.sessionId,
    nonce: envelope.nonce,
    messageId: envelope.messageId,
    body: envelope.body,
  }
  if (envelope.requestId !== undefined) wire.requestId = envelope.requestId
  if (envelope.responseTo !== undefined) wire.responseTo = envelope.responseTo

  const payload = new TextEncoder().encode(JSON.stringify(wire))
  const framed = encodeFrame({ messageClass: "control", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "control envelope exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

export function decodeControlEnvelope(
  payload: Uint8Array,
): ProtocolError | ControlEnvelope {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "control envelope")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(
    object,
    ["protocolVersion", "kind", "sessionId", "nonce", "messageId", "body"],
    ["requestId", "responseTo"],
  )
  if (keyError instanceof ProtocolError) return keyError

  if (object.protocolVersion !== 1) return malformed("protocolVersion must be 1")
  const kind = asString(object.kind, "kind", KIND_MAX)
  if (kind instanceof ProtocolError) return kind
  const sessionId = asString(object.sessionId, "sessionId", SESSION_ID_MAX)
  if (sessionId instanceof ProtocolError) return sessionId
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  if (!isDecimalUint64String(object.messageId)) {
    return malformed("messageId must be a decimal uint64 string")
  }
  if ("requestId" in object && !isDecimalUint64String(object.requestId)) {
    return malformed("requestId must be a decimal uint64 string")
  }
  if ("responseTo" in object && !isDecimalUint64String(object.responseTo)) {
    return malformed("responseTo must be a decimal uint64 string")
  }
  const body = asObject(object.body, "body")
  if (body instanceof ProtocolError) return body

  return {
    protocolVersion: 1,
    kind,
    sessionId,
    nonce: object.nonce,
    messageId: object.messageId,
    ...("requestId" in object ? { requestId: object.requestId as string } : {}),
    ...("responseTo" in object ? { responseTo: object.responseTo as string } : {}),
    body,
  }
}

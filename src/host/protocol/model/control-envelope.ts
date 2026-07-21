import { z } from "zod";

import { encodeFrame } from "infrastructure/framing";

import type { ControlEnvelope } from "../types";
import { ProtocolError } from "./errors";
import {
  boundedStringSchema,
  decimalUint64Schema,
  jsonObjectSchema,
  lowercaseHexSchema,
  malformedFromZodError,
} from "./shape";
import { decodeJsonPayload } from "./strict-json";

const KIND_MAX = 64;
const SESSION_ID_MAX = 64;
const NONCE_HEX_LENGTH = 32;

export function encodeControlEnvelope(envelope: ControlEnvelope): ProtocolError | Uint8Array {
  // Omit the optional id fields when absent so they never serialize as null.
  const wire: Record<string, unknown> = {
    protocolVersion: envelope.protocolVersion,
    kind: envelope.kind,
    sessionId: envelope.sessionId,
    nonce: envelope.nonce,
    messageId: envelope.messageId,
    body: envelope.body,
  };
  if (envelope.requestId !== undefined) wire.requestId = envelope.requestId;
  if (envelope.responseTo !== undefined) wire.responseTo = envelope.responseTo;

  const payload = new TextEncoder().encode(JSON.stringify(wire));
  const framed = encodeFrame({ messageClass: "control", payload });
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "control envelope exceeds the framing limit",
      cause: framed,
    });
  }
  return framed;
}

const controlEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: boundedStringSchema(KIND_MAX),
  sessionId: boundedStringSchema(SESSION_ID_MAX),
  nonce: lowercaseHexSchema(NONCE_HEX_LENGTH),
  messageId: decimalUint64Schema,
  requestId: decimalUint64Schema.optional(),
  responseTo: decimalUint64Schema.optional(),
  body: jsonObjectSchema,
});

export function decodeControlEnvelope(payload: Uint8Array): ProtocolError | ControlEnvelope {
  const value = decodeJsonPayload(payload);
  if (value instanceof ProtocolError) return value;
  const result = controlEnvelopeSchema.safeParse(value);
  if (!result.success) return malformedFromZodError(result.error);
  return result.data;
}

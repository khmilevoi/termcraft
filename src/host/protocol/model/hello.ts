import { z } from "zod"

import { encodeFrame } from "infrastructure/framing"
import type { HostMode } from "../../types"
import type { ClientHelloV1, HostHelloV1 } from "../types"
import { runtimeDeclarationBundleSchema, publicLimitsSchema } from "./bundle"
import { ProtocolError } from "./errors"
import {
  boundedStringSchema,
  lowercaseHexSchema,
  malformedFromZodError,
  positiveSafeIntegerSchema,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"

const NONCE_HEX_LENGTH = 32
const SOURCE_HASH_HEX_LENGTH = 64
const SESSION_ID_MAX = 64
const PAGE_SLUG_MAX = 32

const HOST_MODES = ["preview", "historical", "smoke", "export"] as const satisfies readonly HostMode[]

function encodeControlPayload(value: object): ProtocolError | Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value))
  const framed = encodeFrame({ messageClass: "control", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "control payload exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

// Identity + bundle/limits shape shared by both hellos.
const sharedIdentityShape = {
  sessionId: boundedStringSchema(SESSION_ID_MAX),
  nonce: lowercaseHexSchema(NONCE_HEX_LENGTH),
  runtimeDeclaration: runtimeDeclarationBundleSchema,
  limits: publicLimitsSchema,
}

const clientHelloSchema = z.strictObject({
  framingVersion: z.literal(1),
  kind: z.literal("client.hello"),
  ...sharedIdentityShape,
  offeredFramingVersions: z.tuple([z.literal(1)]),
  offeredProtocolVersions: z.tuple([z.literal(1)]),
  mode: z.enum(HOST_MODES),
  pageSlug: boundedStringSchema(PAGE_SLUG_MAX),
  sourceHash: lowercaseHexSchema(SOURCE_HASH_HEX_LENGTH),
  sourceKitApiVersion: positiveSafeIntegerSchema,
})

const hostHelloSchema = z.strictObject({
  framingVersion: z.literal(1),
  kind: z.literal("host.hello"),
  ...sharedIdentityShape,
  selectedFramingVersion: z.literal(1),
  selectedProtocolVersion: z.literal(1),
})

export function encodeClientHello(hello: ClientHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeClientHello(payload: Uint8Array): ProtocolError | ClientHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const result = clientHelloSchema.safeParse(value)
  if (!result.success) return malformedFromZodError(result.error)
  return result.data
}

export function encodeHostHello(hello: HostHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeHostHello(payload: Uint8Array): ProtocolError | HostHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const result = hostHelloSchema.safeParse(value)
  if (!result.success) return malformedFromZodError(result.error)
  return result.data
}

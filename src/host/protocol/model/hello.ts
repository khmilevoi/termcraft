import { encodeFrame } from "../../../infrastructure/framing"
import type { HostMode } from "../../types"
import type {
  ClientHelloV1,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../types"
import { validatePublicLimits, validateRuntimeDeclarationBundle } from "./bundle"
import { ProtocolError } from "./errors"
import {
  asObject,
  asString,
  expectExactKeys,
  isLowercaseHex,
  isPositiveSafeInteger,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"
import type { JsonValue } from "./strict-json"

const HOST_MODES = new Set<HostMode>(["preview", "historical", "smoke", "export"])
const NONCE_HEX_LENGTH = 32
const SOURCE_HASH_HEX_LENGTH = 64
const SESSION_ID_MAX = 64
const PAGE_SLUG_MAX = 32

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

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

interface SharedIdentity {
  readonly sessionId: string
  readonly nonce: string
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

// Identity + bundle/limits validation shared by both hellos.
function readIdentity(object: { [key: string]: JsonValue }): ProtocolError | SharedIdentity {
  const sessionId = asString(object.sessionId, "sessionId", SESSION_ID_MAX)
  if (sessionId instanceof ProtocolError) return sessionId
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  const runtimeDeclaration = validateRuntimeDeclarationBundle(object.runtimeDeclaration ?? null)
  if (runtimeDeclaration instanceof ProtocolError) return runtimeDeclaration
  const limits = validatePublicLimits(object.limits ?? null)
  if (limits instanceof ProtocolError) return limits
  return { sessionId, nonce: object.nonce, runtimeDeclaration, limits }
}

export function encodeClientHello(hello: ClientHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeClientHello(payload: Uint8Array): ProtocolError | ClientHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "client.hello")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "framingVersion",
    "kind",
    "sessionId",
    "nonce",
    "offeredFramingVersions",
    "offeredProtocolVersions",
    "mode",
    "pageSlug",
    "sourceHash",
    "sourceKitApiVersion",
    "runtimeDeclaration",
    "limits",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.framingVersion !== 1) return malformed("framingVersion must be 1")
  if (object.kind !== "client.hello") return malformed('kind must be "client.hello"')
  if (!isOneArray(object.offeredFramingVersions)) {
    return malformed("offeredFramingVersions must be [1]")
  }
  if (!isOneArray(object.offeredProtocolVersions)) {
    return malformed("offeredProtocolVersions must be [1]")
  }
  if (typeof object.mode !== "string" || !HOST_MODES.has(object.mode as HostMode)) {
    return malformed("mode must be a valid host mode")
  }
  const pageSlug = asString(object.pageSlug, "pageSlug", PAGE_SLUG_MAX)
  if (pageSlug instanceof ProtocolError) return pageSlug
  if (!isLowercaseHex(object.sourceHash, SOURCE_HASH_HEX_LENGTH)) {
    return malformed("sourceHash must be 64 lowercase hex characters")
  }
  if (!isPositiveSafeInteger(object.sourceKitApiVersion)) {
    return malformed("sourceKitApiVersion must be a positive safe integer")
  }
  const identity = readIdentity(object)
  if (identity instanceof ProtocolError) return identity

  return {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: object.mode as HostMode,
    pageSlug,
    sourceHash: object.sourceHash,
    sourceKitApiVersion: object.sourceKitApiVersion,
    runtimeDeclaration: identity.runtimeDeclaration,
    limits: identity.limits,
  }
}

export function encodeHostHello(hello: HostHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeHostHello(payload: Uint8Array): ProtocolError | HostHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "host.hello")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "framingVersion",
    "kind",
    "sessionId",
    "nonce",
    "selectedFramingVersion",
    "selectedProtocolVersion",
    "runtimeDeclaration",
    "limits",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.framingVersion !== 1) return malformed("framingVersion must be 1")
  if (object.kind !== "host.hello") return malformed('kind must be "host.hello"')
  if (object.selectedFramingVersion !== 1) return malformed("selectedFramingVersion must be 1")
  if (object.selectedProtocolVersion !== 1) return malformed("selectedProtocolVersion must be 1")
  const identity = readIdentity(object)
  if (identity instanceof ProtocolError) return identity

  return {
    framingVersion: 1,
    kind: "host.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    selectedFramingVersion: 1,
    selectedProtocolVersion: 1,
    runtimeDeclaration: identity.runtimeDeclaration,
    limits: identity.limits,
  }
}

function isOneArray(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 1
}

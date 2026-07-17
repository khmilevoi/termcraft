import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
} from "../../../infrastructure/framing"
import type { PublicLimits, RuntimeDeclarationBundleV1 } from "../types"
import { ProtocolError } from "./errors"
import {
  asArray,
  asObject,
  expectExactKeys,
  isBoundedAscii,
  isPositiveSafeInteger,
  isSortedUniqueNumbers,
  isSortedUniqueStrings,
} from "./shape"
import type { JsonValue } from "./strict-json"

/** The protocol hard caps (§5). Client/host limits may be no larger. */
export const PROTOCOL_HARD_LIMITS: PublicLimits = {
  controlPayloadBytes: CONTROL_PAYLOAD_LIMIT_BYTES,
  framePayloadBytes: DATA_PAYLOAD_LIMIT_BYTES,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
}

const CAPABILITY_ID_MAX = 128

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function validateRuntimeDeclarationBundle(
  value: JsonValue,
): ProtocolError | RuntimeDeclarationBundleV1 {
  const object = asObject(value, "runtimeDeclaration")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "module",
    "currentKitApiVersion",
    "supportedKitApiVersions",
    "publicCapabilityIds",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.module !== "@termcraft/runtime") {
    return malformed('runtimeDeclaration.module must be "@termcraft/runtime"')
  }
  if (!isPositiveSafeInteger(object.currentKitApiVersion)) {
    return malformed("currentKitApiVersion must be a positive safe integer")
  }

  const supported = asArray(object.supportedKitApiVersions, "supportedKitApiVersions")
  if (supported instanceof ProtocolError) return supported
  if (!supported.every(isPositiveSafeInteger)) {
    return malformed("supportedKitApiVersions must be positive safe integers")
  }
  if (!isSortedUniqueNumbers(supported)) {
    return malformed("supportedKitApiVersions must be sorted and duplicate-free")
  }
  if (!supported.includes(object.currentKitApiVersion)) {
    return malformed("supportedKitApiVersions must contain currentKitApiVersion")
  }

  const capabilities = asArray(object.publicCapabilityIds, "publicCapabilityIds")
  if (capabilities instanceof ProtocolError) return capabilities
  if (!capabilities.every((id) => isBoundedAscii(id, CAPABILITY_ID_MAX))) {
    return malformed("publicCapabilityIds must be non-empty bounded ASCII strings")
  }
  if (!isSortedUniqueStrings(capabilities)) {
    return malformed("publicCapabilityIds must be sorted and duplicate-free")
  }

  return {
    module: "@termcraft/runtime",
    currentKitApiVersion: object.currentKitApiVersion,
    supportedKitApiVersions: supported,
    publicCapabilityIds: capabilities,
  }
}

export function validatePublicLimits(value: JsonValue): ProtocolError | PublicLimits {
  const object = asObject(value, "limits")
  if (object instanceof ProtocolError) return object

  const fields = [
    "controlPayloadBytes",
    "framePayloadBytes",
    "maxFrameWidth",
    "maxFrameHeight",
    "maxFrameCells",
  ] as const

  const keyError = expectExactKeys(object, fields)
  if (keyError instanceof ProtocolError) return keyError

  for (const field of fields) {
    const raw = object[field]
    if (!isPositiveSafeInteger(raw)) {
      return malformed(`${field} must be a positive safe integer`)
    }
    if (raw > PROTOCOL_HARD_LIMITS[field]) {
      return malformed(`${field} exceeds the protocol hard limit`)
    }
  }

  return {
    controlPayloadBytes: object.controlPayloadBytes as number,
    framePayloadBytes: object.framePayloadBytes as number,
    maxFrameWidth: object.maxFrameWidth as number,
    maxFrameHeight: object.maxFrameHeight as number,
    maxFrameCells: object.maxFrameCells as number,
  }
}

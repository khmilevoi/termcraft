import { z } from "zod"

import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
} from "infrastructure/framing"
import type { PublicLimits, RuntimeDeclarationBundleV1 } from "../types"
import type { ProtocolError } from "./errors"
import {
  boundedAsciiSchema,
  malformedFromZodError,
  positiveSafeIntegerSchema,
  sortedUniqueNumberArraySchema,
  sortedUniqueStringArraySchema,
} from "./shape"

/** The protocol hard caps (§5). Client/host limits may be no larger. */
export const PROTOCOL_HARD_LIMITS: PublicLimits = {
  controlPayloadBytes: CONTROL_PAYLOAD_LIMIT_BYTES,
  framePayloadBytes: DATA_PAYLOAD_LIMIT_BYTES,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
}

const CAPABILITY_ID_MAX = 128

export const runtimeDeclarationBundleSchema = z
  .strictObject({
    module: z.literal("@termcraft/runtime"),
    currentKitApiVersion: positiveSafeIntegerSchema,
    supportedKitApiVersions: sortedUniqueNumberArraySchema(positiveSafeIntegerSchema),
    publicCapabilityIds: sortedUniqueStringArraySchema(boundedAsciiSchema(CAPABILITY_ID_MAX)),
  })
  .superRefine((val, ctx) => {
    if (!val.supportedKitApiVersions.includes(val.currentKitApiVersion)) {
      ctx.addIssue({ code: "custom", message: "supportedKitApiVersions must contain currentKitApiVersion" })
    }
  })

export function validateRuntimeDeclarationBundle(value: unknown): ProtocolError | RuntimeDeclarationBundleV1 {
  const result = runtimeDeclarationBundleSchema.safeParse(value)
  if (!result.success) return malformedFromZodError(result.error)
  return result.data
}

function boundedPositiveInt(max: number) {
  return positiveSafeIntegerSchema.refine((value) => value <= max, {
    error: "exceeds the protocol hard limit",
  })
}

export const publicLimitsSchema = z.strictObject({
  controlPayloadBytes: boundedPositiveInt(PROTOCOL_HARD_LIMITS.controlPayloadBytes),
  framePayloadBytes: boundedPositiveInt(PROTOCOL_HARD_LIMITS.framePayloadBytes),
  maxFrameWidth: boundedPositiveInt(PROTOCOL_HARD_LIMITS.maxFrameWidth),
  maxFrameHeight: boundedPositiveInt(PROTOCOL_HARD_LIMITS.maxFrameHeight),
  maxFrameCells: boundedPositiveInt(PROTOCOL_HARD_LIMITS.maxFrameCells),
})

export function validatePublicLimits(value: unknown): ProtocolError | PublicLimits {
  const result = publicLimitsSchema.safeParse(value)
  if (!result.success) return malformedFromZodError(result.error)
  return result.data
}

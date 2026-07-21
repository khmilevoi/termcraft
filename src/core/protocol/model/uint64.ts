import * as errore from "errore"
import { z } from "zod"

/**
 * The Kernel's two counters — `stateRevision` and `eventSeq` — are process-local
 * unsigned 64-bit values (kernel-command-contract §4). They are `bigint` internally
 * and canonical decimal strings on every DTO: "Unsigned 64-bit values are encoded in
 * DTOs as canonical decimal strings. Internally they may be `bigint`; `bigint` never
 * crosses a DTO boundary."
 *
 * Canonical means exactly one spelling per value — no leading zero except the single
 * digit "0", no sign, no whitespace, no exponent. That is load-bearing rather than
 * cosmetic: §8.5 dedupes commands by a canonical hash of the complete envelope, so two
 * envelopes that mean the same thing must serialize identically or the same intent
 * would hash two ways and defeat exactly-once handling.
 */
export type UInt64String = string

/** The largest unsigned 64-bit value, `2^64 - 1`. */
export const UINT64_MAX = 18_446_744_073_709_551_615n

/** A `UInt64String` that is not canonical, not decimal, or outside the unsigned 64-bit range. */
export class Uint64DecodeError extends errore.createTaggedError({
  name: "Uint64DecodeError",
  message: "not a canonical uint64 string: $reason",
}) {}

/**
 * Canonical decimal: either the single digit "0", or a non-zero leading digit followed
 * by any digits. Anchored, so no leading/trailing whitespace, sign, or suffix survives.
 */
const CANONICAL_UINT64 = /^(?:0|[1-9][0-9]*)$/

/** True when `raw` is a canonical decimal string within the unsigned 64-bit range. */
export function isUint64String(raw: string): raw is UInt64String {
  if (!CANONICAL_UINT64.test(raw)) return false
  return BigInt(raw) <= UINT64_MAX
}

/** Encodes a counter for a DTO. Values outside the unsigned 64-bit range are a caller bug, not input. */
export function encodeUint64String(value: bigint): UInt64String {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(`uint64 out of range: ${value}`)
  }
  return value.toString(10)
}

/** Decodes a DTO counter back to `bigint`, returning the error as a value. */
export function decodeUint64String(raw: string): Uint64DecodeError | bigint {
  if (!CANONICAL_UINT64.test(raw)) {
    return new Uint64DecodeError({ reason: `"${raw}" is not canonical decimal` })
  }
  const value = BigInt(raw)
  if (value > UINT64_MAX) {
    return new Uint64DecodeError({ reason: `"${raw}" exceeds 2^64-1` })
  }
  return value
}

/**
 * Orders two canonical counters numerically. Lexicographic order is wrong here — "9"
 * sorts after "10" as text — and `eventSeq` monotonicity assertions depend on this.
 */
export function compareUint64Strings(left: UInt64String, right: UInt64String): -1 | 0 | 1 {
  const a = BigInt(left)
  const b = BigInt(right)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Zod schema for a canonical `UInt64String`, for use inside envelope/payload schemas. */
export const uint64StringSchema = z
  .string()
  .refine(isUint64String, { message: "expected a canonical uint64 decimal string" })

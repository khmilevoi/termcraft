import { ProtocolError } from "./errors"
import type { JsonValue } from "./strict-json"

// Field access on a `{ [k]: JsonValue }` object yields `JsonValue | undefined`
// under noUncheckedIndexedAccess, so every guard accepts the widened input.
type MaybeJson = JsonValue | undefined

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

/** Narrow to a plain object (not null, not an array). */
export function asObject(
  value: MaybeJson,
  label: string,
): ProtocolError | { [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return malformed(`${label} must be a JSON object`)
  }
  return value
}

/** Narrow to an array. */
export function asArray(value: MaybeJson, label: string): ProtocolError | JsonValue[] {
  if (!Array.isArray(value)) return malformed(`${label} must be a JSON array`)
  return value
}

/** Narrow to a non-empty string within `maxLength`. */
export function asString(
  value: MaybeJson,
  label: string,
  maxLength: number,
): ProtocolError | string {
  if (typeof value !== "string") return malformed(`${label} must be a string`)
  if (value.length === 0) return malformed(`${label} must not be empty`)
  if (value.length > maxLength) return malformed(`${label} exceeds ${maxLength} characters`)
  return value
}

/** Reject unknown keys and missing required keys; optional keys may be absent. */
export function expectExactKeys(
  object: { [key: string]: JsonValue },
  required: readonly string[],
  optional: readonly string[] = [],
): ProtocolError | null {
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) return malformed(`unexpected field ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!(key in object)) return malformed(`missing required field ${JSON.stringify(key)}`)
  }
  return null
}

export function isPositiveSafeInteger(value: MaybeJson): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function isSortedUniqueNumbers(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))
}

export function isSortedUniqueStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))
}

/** Non-empty printable-ASCII string within `maxLength` (§7.1 capability ids). */
export function isBoundedAscii(value: MaybeJson, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  )
}

const MAX_UINT64_DECIMAL = "18446744073709551615"

/** A decimal string for an unsigned integer ≥ 1, bounded to 64 bits. */
export function isDecimalUint64String(value: MaybeJson): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false
  if (value.length > MAX_UINT64_DECIMAL.length) return false
  if (value.length === MAX_UINT64_DECIMAL.length && value > MAX_UINT64_DECIMAL) return false
  return true
}

/** Exactly `length` lowercase hexadecimal characters. */
export function isLowercaseHex(value: MaybeJson, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
}

import { describe, expect, test } from "bun:test"

import {
  UINT64_MAX,
  Uint64DecodeError,
  compareUint64Strings,
  decodeUint64String,
  encodeUint64String,
  isUint64String,
  uint64StringSchema,
} from "./uint64"

describe("encodeUint64String", () => {
  test("encodes zero as the single canonical zero digit", () => {
    expect(encodeUint64String(0n)).toBe("0")
  })

  test("encodes the maximum unsigned 64-bit value", () => {
    expect(encodeUint64String(UINT64_MAX)).toBe("18446744073709551615")
  })

  test("never emits a leading zero", () => {
    expect(encodeUint64String(1n)).toBe("1")
    expect(encodeUint64String(10n)).toBe("10")
  })
})

describe("decodeUint64String", () => {
  test("round-trips every canonical encoding", () => {
    for (const value of [0n, 1n, 42n, 999n, UINT64_MAX]) {
      expect(decodeUint64String(encodeUint64String(value))).toBe(value)
    }
  })

  test("rejects a leading zero because it is not canonical", () => {
    // "01" and "0" denote the same number; only one of them may cross the DTO
    // boundary, or two envelopes with equal meaning would hash differently.
    expect(decodeUint64String("01")).toBeInstanceOf(Uint64DecodeError)
    expect(decodeUint64String("00")).toBeInstanceOf(Uint64DecodeError)
  })

  test("rejects a negative, fractional, signed, or empty value", () => {
    for (const raw of ["-1", "1.0", "+1", "", " 1", "1 ", "1e3", "0x1f"]) {
      expect(decodeUint64String(raw)).toBeInstanceOf(Uint64DecodeError)
    }
  })

  test("rejects a value above the unsigned 64-bit ceiling", () => {
    expect(decodeUint64String("18446744073709551616")).toBeInstanceOf(Uint64DecodeError)
  })

  test("accepts the ceiling itself", () => {
    expect(decodeUint64String("18446744073709551615")).toBe(UINT64_MAX)
  })
})

describe("isUint64String", () => {
  test("narrows only canonical decimal strings", () => {
    expect(isUint64String("0")).toBe(true)
    expect(isUint64String("18446744073709551615")).toBe(true)
    expect(isUint64String("01")).toBe(false)
    expect(isUint64String("18446744073709551616")).toBe(false)
  })
})

describe("compareUint64Strings", () => {
  test("orders numerically, not lexicographically", () => {
    // "9" > "10" lexicographically; the counters must not order that way.
    expect(compareUint64Strings("9", "10")).toBe(-1)
    expect(compareUint64Strings("10", "9")).toBe(1)
    expect(compareUint64Strings("10", "10")).toBe(0)
  })
})

describe("uint64StringSchema", () => {
  test("accepts a canonical value and rejects a non-canonical one", () => {
    expect(uint64StringSchema.safeParse("12").success).toBe(true)
    expect(uint64StringSchema.safeParse("012").success).toBe(false)
    expect(uint64StringSchema.safeParse(12).success).toBe(false)
  })
})

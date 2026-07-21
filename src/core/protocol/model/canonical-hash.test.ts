import { describe, expect, test } from "bun:test"

import { CanonicalHashError, canonicalJson, canonicalHash } from "./canonical-hash"

describe("canonicalJson", () => {
  test("orders object keys so that key order cannot change the hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  test("orders nested keys too", () => {
    const left = { outer: { z: 1, a: 2 } }
    const right = { outer: { a: 2, z: 1 } }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  test("preserves array order — arrays are sequences, not sets", () => {
    // page.reorder's payload IS a permutation; sorting it would erase the intent.
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })

  test("distinguishes null from an absent key", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })

  test("encodes primitives canonically", () => {
    expect(canonicalJson("x")).toBe('"x"')
    expect(canonicalJson(0)).toBe("0")
    expect(canonicalJson(true)).toBe("true")
    expect(canonicalJson(null)).toBe("null")
  })

  test("rejects a value no DTO may contain", () => {
    // §8.1: DTOs contain no Error, Date, Map, Set, class instance, function,
    // undefined, or bigint. Silently coercing one would let two different
    // envelopes canonicalize identically.
    expect(canonicalJson(undefined)).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(1n)).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(new Date(0))).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(new Map())).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(new Set())).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(() => 1)).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(new Error("x"))).toBeInstanceOf(CanonicalHashError)
  })

  test("rejects a nested forbidden value, not just a top-level one", () => {
    expect(canonicalJson({ a: { b: undefined } })).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson([1, 2n])).toBeInstanceOf(CanonicalHashError)
  })

  test("rejects a non-finite number", () => {
    expect(canonicalJson(Number.NaN)).toBeInstanceOf(CanonicalHashError)
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBeInstanceOf(CanonicalHashError)
  })

  test("rejects a cycle instead of hanging", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(canonicalJson(cyclic)).toBeInstanceOf(CanonicalHashError)
  })
})

describe("canonicalHash", () => {
  test("is stable across key order", () => {
    const left = canonicalHash({ kind: "turn.start", payload: { text: "hi" } })
    const right = canonicalHash({ payload: { text: "hi" }, kind: "turn.start" })
    expect(left).toBe(right)
  })

  test("changes when any field changes", () => {
    const base = canonicalHash({ kind: "turn.start", payload: { text: "hi" } })
    expect(canonicalHash({ kind: "turn.start", payload: { text: "hí" } })).not.toBe(base)
    expect(canonicalHash({ kind: "turn.cancel", payload: { text: "hi" } })).not.toBe(base)
  })

  test("returns 64 lowercase hex characters", () => {
    const hash = canonicalHash({ a: 1 })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("propagates the canonicalization error rather than hashing a lie", () => {
    expect(canonicalHash({ a: undefined })).toBeInstanceOf(CanonicalHashError)
  })
})

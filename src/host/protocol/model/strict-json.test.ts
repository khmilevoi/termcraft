import { describe, expect, test } from "bun:test"

import { ProtocolError } from "./errors"
import { decodeJsonPayload, decodeUtf8, parseStrictJson } from "./strict-json"

const utf8 = (text: string) => new TextEncoder().encode(text)

describe("decodeUtf8", () => {
  test("decodes valid UTF-8", () => {
    expect(decodeUtf8(utf8('{"kind":"héllo"}'))).toBe('{"kind":"héllo"}')
  })

  test("rejects invalid UTF-8 as a ProtocolError", () => {
    const result = decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd]))
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })
})

describe("parseStrictJson", () => {
  test("parses a valid nested value", () => {
    expect(parseStrictJson('{"a":[1,2,{"b":true}],"c":"x"}')).toEqual({
      a: [1, 2, { b: true }],
      c: "x",
    })
  })

  test("rejects malformed JSON", () => {
    expect(parseStrictJson("{not json")).toBeInstanceOf(ProtocolError)
  })

  test("rejects trailing content after the value", () => {
    expect(parseStrictJson('{"a":1} trailing')).toBeInstanceOf(ProtocolError)
  })

  test("rejects a duplicate object key at the top level", () => {
    const result = parseStrictJson('{"a":1,"a":2}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("duplicate")
  })

  test("rejects a duplicate key differing only by unicode escape", () => {
    expect(parseStrictJson('{"a":1,"\\u0061":2}')).toBeInstanceOf(ProtocolError)
  })

  test("rejects a duplicate key nested inside an array", () => {
    expect(parseStrictJson('{"list":[{"k":1,"k":2}]}')).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unsafe-integer JSON number token", () => {
    const result = parseStrictJson('{"id":9007199254740992}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("unsafe")
  })

  test("rejects an unsafe integer nested in an array", () => {
    expect(parseStrictJson("[1,2,90071992547409931]")).toBeInstanceOf(ProtocolError)
  })

  test("rejects a number token that parses to Infinity", () => {
    const result = parseStrictJson('{"n":1e999}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("non-finite")
  })

  test("rejects an unsafe integer written in exponent form", () => {
    // 1e20 = 100000000000000000000 is an integer value beyond the safe range.
    expect(parseStrictJson('{"n":1e20}')).toBeInstanceOf(ProtocolError)
  })

  test("accepts the largest safe integer", () => {
    expect(parseStrictJson('{"n":9007199254740991}')).toEqual({ n: 9007199254740991 })
  })

  test("accepts floats and exponents, not flagged as unsafe integers", () => {
    expect(parseStrictJson('{"x":1.5,"y":1e3}')).toEqual({ x: 1.5, y: 1000 })
  })

  test("does not treat a colon or brace inside a string as structure", () => {
    expect(parseStrictJson('{"a":"b:{}c","a2":1}')).toEqual({ a: "b:{}c", a2: 1 })
  })

  test("does not flag a big number that appears inside a string", () => {
    expect(parseStrictJson('{"id":"9007199254740992"}')).toEqual({
      id: "9007199254740992",
    })
  })
})

describe("decodeJsonPayload", () => {
  test("chains utf-8 + strict json", () => {
    expect(decodeJsonPayload(utf8('{"k":1}'))).toEqual({ k: 1 })
  })

  test("propagates a utf-8 error", () => {
    expect(decodeJsonPayload(new Uint8Array([0xff]))).toBeInstanceOf(ProtocolError)
  })

  test("propagates a strict-json error", () => {
    expect(decodeJsonPayload(utf8('{"a":1,"a":2}'))).toBeInstanceOf(ProtocolError)
  })
})

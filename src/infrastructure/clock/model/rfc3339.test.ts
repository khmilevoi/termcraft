import { describe, expect, test } from "bun:test"

import { isRfc3339Utc } from "./rfc3339"

describe("isRfc3339Utc", () => {
  test("accepts UTC timestamps", () => {
    expect(isRfc3339Utc("2026-07-19T12:00:00Z")).toBe(true)
    expect(isRfc3339Utc("2026-07-19T12:00:00.123Z")).toBe(true)
    expect(isRfc3339Utc("2026-07-19T12:00:00+00:00")).toBe(true)
  })

  test("rejects non-UTC, malformed, and non-calendar values", () => {
    expect(isRfc3339Utc("2026-07-19T12:00:00+02:00")).toBe(false) // non-UTC offset
    expect(isRfc3339Utc("2026-07-19 12:00:00Z")).toBe(false) // space, no T
    expect(isRfc3339Utc("2026-07-19")).toBe(false) // date only
    expect(isRfc3339Utc("2026-13-19T12:00:00Z")).toBe(false) // month 13 -> Date.parse NaN
    expect(isRfc3339Utc("")).toBe(false)
  })
})

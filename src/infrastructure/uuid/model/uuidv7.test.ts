import { describe, expect, test } from "bun:test"

import { uuidv7 } from "./uuidv7"

const UUID_V7_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("uuidv7", () => {
  test("produces canonical lowercase v7 ids", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(uuidv7()).toMatch(UUID_V7_SHAPE)
    }
  })

  test("ids generated in sequence sort in generation order", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7())
    expect([...ids].sort()).toEqual(ids)
  })

  test("ids are unique", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7())
    expect(new Set(ids).size).toBe(ids.length)
  })
})

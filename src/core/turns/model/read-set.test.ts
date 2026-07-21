import { describe, expect, test } from "bun:test"

import type { PageSlug } from "entities/page"
import type { StagedTurnReadSetV1 } from "core/ports"

import { ReadSetTranslationError, toFinalizeReadSet } from "./read-set"

const slug = (value: string): PageSlug => value as PageSlug
const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const SHA_C = "c".repeat(64)

function staged(overrides: Partial<StagedTurnReadSetV1> = {}): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: SHA_A, size: 120 },
    canonicalPages: [{ pageSlug: slug("home"), snapshot: { sha256: SHA_B, size: 400 } }],
    chat: { length: 2048, prefixSha256: SHA_C },
    pins: [{ pageSlug: slug("home"), base: { length: 64, prefixSha256: SHA_A } }],
    ...overrides,
  }
}

describe("toFinalizeReadSet", () => {
  test("translates a populated read set field for field", () => {
    const result = toFinalizeReadSet(staged())
    if (result instanceof Error) throw result

    expect(result.manifest).toEqual({ state: "file", sha256: SHA_A, size: 120 })
    expect(result.canonicalPages.get(slug("home"))).toEqual({ state: "file", sha256: SHA_B, size: 400 })
    expect(result.chat).toEqual({ length: 2048, prefixSha256: SHA_C })
    expect(result.pins.get(slug("home"))).toEqual({ length: 64, prefixSha256: SHA_A })
  })

  test("a null snapshot becomes an explicit absent image, never a dropped entry", () => {
    // The two shapes encode "this file does not exist" differently: staging uses `null`,
    // finalization uses `{state:"absent"}`. Dropping the entry instead would turn "I
    // checked, and it was absent" into "I never checked" — and the final CAS would then
    // silently permit a file that appeared mid-turn.
    const result = toFinalizeReadSet(
      staged({
        manifest: null,
        canonicalPages: [{ pageSlug: slug("home"), snapshot: null }],
      }),
    )
    if (result instanceof Error) throw result

    expect(result.manifest).toEqual({ state: "absent" })
    expect(result.canonicalPages.has(slug("home"))).toBe(true)
    expect(result.canonicalPages.get(slug("home"))).toEqual({ state: "absent" })
  })

  test("is TOTAL over both arrays — every entry survives", () => {
    // A dropped entry silently weakens the CAS: the drifted file is simply never compared.
    const pages = ["home", "about", "pricing", "contact"] as const
    const result = toFinalizeReadSet(
      staged({
        canonicalPages: pages.map((p) => ({ pageSlug: slug(p), snapshot: { sha256: SHA_B, size: 1 } })),
        pins: pages.map((p) => ({ pageSlug: slug(p), base: { length: 1, prefixSha256: SHA_C } })),
      }),
    )
    if (result instanceof Error) throw result

    expect(result.canonicalPages.size).toBe(pages.length)
    expect(result.pins.size).toBe(pages.length)
    for (const p of pages) {
      expect(result.canonicalPages.has(slug(p)), `page ${p} was dropped`).toBe(true)
      expect(result.pins.has(slug(p)), `pins for ${p} were dropped`).toBe(true)
    }
  })

  test("a duplicate page slug is an ERROR, not a silently collapsed Map entry", () => {
    // This is the hazard of array -> Map: `new Map(pairs)` keeps the LAST duplicate and
    // discards the rest without a sound. If the two entries disagreed, the CAS would
    // silently compare against the wrong image; if they agreed, the input was already
    // malformed. Either way it must surface rather than be normalized away.
    const duplicated = toFinalizeReadSet(
      staged({
        canonicalPages: [
          { pageSlug: slug("home"), snapshot: { sha256: SHA_A, size: 1 } },
          { pageSlug: slug("home"), snapshot: { sha256: SHA_B, size: 2 } },
        ],
      }),
    )
    expect(duplicated).toBeInstanceOf(ReadSetTranslationError)
  })

  test("a duplicate pins slug is an error too", () => {
    const duplicated = toFinalizeReadSet(
      staged({
        pins: [
          { pageSlug: slug("home"), base: { length: 1, prefixSha256: SHA_A } },
          { pageSlug: slug("home"), base: { length: 2, prefixSha256: SHA_B } },
        ],
      }),
    )
    expect(duplicated).toBeInstanceOf(ReadSetTranslationError)
  })

  test("empty arrays translate to empty maps, not to a missing read set", () => {
    const result = toFinalizeReadSet(staged({ canonicalPages: [], pins: [] }))
    if (result instanceof Error) throw result

    expect(result.canonicalPages.size).toBe(0)
    expect(result.pins.size).toBe(0)
    // The manifest and chat halves are unaffected by empty page/pin sets.
    expect(result.manifest).toEqual({ state: "file", sha256: SHA_A, size: 120 })
    expect(result.chat).toEqual({ length: 2048, prefixSha256: SHA_C })
  })

  test("the translation copies values, so mutating the input afterwards cannot change it", () => {
    // The staged set comes from a port; nothing guarantees the caller stops holding it.
    const pages = [{ pageSlug: slug("home"), snapshot: { sha256: SHA_B, size: 400 } }]
    const input = staged({ canonicalPages: pages })
    const result = toFinalizeReadSet(input)
    if (result instanceof Error) throw result

    // Mutate the array the input still references.
    ;(pages as { pageSlug: PageSlug; snapshot: { sha256: string; size: number } | null }[]).push({
      pageSlug: slug("about"),
      snapshot: null,
    })

    expect(result.canonicalPages.size).toBe(1)
    expect(result.canonicalPages.has(slug("about"))).toBe(false)
  })
})

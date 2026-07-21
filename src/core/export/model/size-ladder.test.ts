import { describe, expect, test } from "bun:test"

import { parsePageSlug } from "entities/page"
import type { PageSlug, Size } from "entities/page"

import { STANDARD_EXPORT_SIZES, computeExportSizeLadder, computePageSizeLadder } from "./size-ladder"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

describe("computePageSizeLadder", () => {
  test("a minSize below both standard sizes yields all three, ordered by (w, h)", () => {
    const ladder = computePageSizeLadder({ w: 80, h: 24 })
    expect(ladder).toEqual([
      { w: 80, h: 24 },
      { w: 120, h: 40 },
      { w: 160, h: 40 },
    ])
  })

  test("a minSize exactly equal to a standard size dedupes to two entries, not three", () => {
    const ladder = computePageSizeLadder({ w: 120, h: 40 })
    expect(ladder).toEqual([
      { w: 120, h: 40 },
      { w: 160, h: 40 },
    ])
  })

  test("a minSize narrower than 120x40 in height but wider in width drops 120x40, keeps 160x40", () => {
    // w=130 > 120 so 120x40 is dropped (too narrow); h=30 <= 40 so 160x40 survives.
    const ladder = computePageSizeLadder({ w: 130, h: 30 })
    expect(ladder).toEqual([
      { w: 130, h: 30 },
      { w: 160, h: 40 },
    ])
  })

  test("a minSize larger than both standard sizes drops both, keeping only minSize", () => {
    const ladder = computePageSizeLadder({ w: 200, h: 50 })
    expect(ladder).toEqual([{ w: 200, h: 50 }])
  })

  test("STANDARD_EXPORT_SIZES is exactly 120x40 and 160x40, in that order", () => {
    expect(STANDARD_EXPORT_SIZES).toEqual([
      { w: 120, h: 40 },
      { w: 160, h: 40 },
    ])
  })
})

describe("computeExportSizeLadder", () => {
  test("orders every page's entries by (manifestIndex, w, h), regardless of input order", () => {
    const pages = [
      { pageSlug: slug("about"), manifestIndex: 1, minSize: { w: 80, h: 24 } as Size },
      { pageSlug: slug("home"), manifestIndex: 0, minSize: { w: 130, h: 30 } as Size },
    ]

    const ladder = computeExportSizeLadder(pages)

    expect(ladder).toEqual([
      { manifestIndex: 0, pageSlug: slug("home"), size: { w: 130, h: 30 } },
      { manifestIndex: 0, pageSlug: slug("home"), size: { w: 160, h: 40 } },
      { manifestIndex: 1, pageSlug: slug("about"), size: { w: 80, h: 24 } },
      { manifestIndex: 1, pageSlug: slug("about"), size: { w: 120, h: 40 } },
      { manifestIndex: 1, pageSlug: slug("about"), size: { w: 160, h: 40 } },
    ])
  })

  test("an empty page list yields an empty ladder", () => {
    expect(computeExportSizeLadder([])).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes, type CapturedLine } from "@opentui/core"

import { styledRowsFromSpanLines } from "./span-rows"

const span = (text: string, fg: RGBA, bg: RGBA, attributes: number, width: number) => ({
  text,
  fg,
  bg,
  attributes,
  width,
})

describe("styledRowsFromSpanLines", () => {
  test("maps each span to a StyledRun with mapped color + attrs", () => {
    const lines: CapturedLine[] = [
      {
        spans: [
          span("ab", RGBA.defaultForeground(), RGBA.fromIndex(0), TextAttributes.BOLD, 2),
          span("c", RGBA.fromInts(255, 136, 0), RGBA.defaultBackground(), TextAttributes.INVERSE, 1),
        ],
      },
      { spans: [span("xyz", RGBA.defaultForeground(), RGBA.defaultBackground(), 0, 3)] },
    ]
    expect(styledRowsFromSpanLines(lines)).toEqual([
      [
        { text: "ab", fg: "default", bg: { indexed: 0 }, attrs: 1 },
        { text: "c", fg: { rgb: "#ff8800" }, bg: "default", attrs: 16 },
      ],
      [{ text: "xyz", fg: "default", bg: "default", attrs: 0 }],
    ])
  })

  test("maps an empty line to an empty row", () => {
    expect(styledRowsFromSpanLines([{ spans: [] }])).toEqual([[]])
  })
})

/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "host/render/types"
import type { StyledRun } from "host/protocol"
import { createHeadlessRenderer } from "host/render/model/renderer"
import { themeTokens } from "../model/tokens"
import { Text } from "./text"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] => frame.rows[row] ?? []
const lineText = (frame: { rows: StyledRun[][] }, row: number) => lineRuns(frame, row).map((run) => run.text).join("")

describe("Text component (design-system §3.2)", () => {
  test("renders its children as themed text", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 1 })
    open = handle
    handle.mount(<Text id="greeting">hello</Text>)
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("hello")
  })

  test("a semantic color token resolves to the theme's hue on the styled run", async () => {
    const handle = await createHeadlessRenderer({ w: 8, h: 1 })
    open = handle
    handle.mount(
      <Text id="danger" color="danger">
        x
      </Text>,
    )
    await handle.render()
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("x"))
    expect((styled?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").danger)
  })

  test("bold + dim set the protocol attribute mask (BOLD=1, DIM=2)", async () => {
    const handle = await createHeadlessRenderer({ w: 6, h: 1 })
    open = handle
    handle.mount(
      <Text id="b" bold dim>
        hi
      </Text>,
    )
    await handle.render()
    const styled = lineRuns(handle.capture(), 0).find((run) => run.text.includes("h"))
    expect((styled?.attrs ?? 0) & 0b11).toBe(0b11)
  })
})

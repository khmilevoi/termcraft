/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "../../host/render/types"
import type { StyledRun } from "../../host/protocol"
import { createHeadlessRenderer } from "../../host/render/model/renderer"
import { themeTokens } from "../model/tokens"
import { List } from "./list"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] => frame.rows[row] ?? []
const lineText = (frame: { rows: StyledRun[][] }, row: number) => lineRuns(frame, row).map((run) => run.text).join("")

const ITEMS = [
  { id: "a", label: "alpha" },
  { id: "b", label: "bravo" },
  { id: "c", label: "charlie" },
]

describe("List component (design-system §3.2)", () => {
  test("renders every item label on its own row", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(<List id="menu" items={ITEMS} />)
    await handle.render()
    const frame = handle.capture()
    expect(lineText(frame, 0)).toContain("alpha")
    expect(lineText(frame, 1)).toContain("bravo")
    expect(lineText(frame, 2)).toContain("charlie")
  })

  test("the selected row carries the accent hue and bold attribute", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(<List id="menu" items={ITEMS} selectedId="b" />)
    await handle.render()
    const selected = lineRuns(handle.capture(), 1).find((run) => run.text.includes("bravo"))
    expect((selected?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").accent)
    expect((selected?.attrs ?? 0) & 0b1).toBe(0b1)
  })

  test("unselected rows use the foreground hue and no bold", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(<List id="menu" items={ITEMS} selectedId="b" />)
    await handle.render()
    const other = lineRuns(handle.capture(), 0).find((run) => run.text.includes("alpha"))
    expect((other?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foreground)
    expect((other?.attrs ?? 0) & 0b1).toBe(0)
  })
})

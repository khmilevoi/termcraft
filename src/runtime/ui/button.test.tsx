/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "../../host/render/types"
import type { StyledRun } from "../../host/protocol"
import { createHeadlessRenderer } from "../../host/render/model/renderer"
import { themeTokens } from "../model/tokens"
import { Button } from "./button"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat()
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle))

describe("Button component (design-system §3.2)", () => {
  test("renders its label inside the bordered box", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(<Button id="save">Save</Button>)
    await handle.render()
    const label = findRun(handle.capture(), "Save")
    expect(label?.text).toContain("Save")
  })

  test("an enabled button colors its label with the foreground token", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(<Button id="ok">Ok</Button>)
    await handle.render()
    const label = findRun(handle.capture(), "Ok")
    expect((label?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foreground)
  })

  test("a disabled button colors its label with the muted token", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 3 })
    open = handle
    handle.mount(
      <Button id="off" disabled>
        No
      </Button>,
    )
    await handle.render()
    const label = findRun(handle.capture(), "No")
    expect((label?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foregroundMuted)
  })
})

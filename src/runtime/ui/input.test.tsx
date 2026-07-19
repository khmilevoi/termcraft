/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "../../host/render/types"
import type { StyledRun } from "../../host/protocol"
import { createHeadlessRenderer } from "../../host/render/model/renderer"
import { themeTokens } from "../model/tokens"
import { Input } from "./input"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const allRuns = (frame: { rows: StyledRun[][] }): StyledRun[] => frame.rows.flat()
const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  allRuns(frame).find((run) => run.text.includes(needle))

// The headless harness DOES paint the input's text: the value shows when set,
// otherwise the placeholder, each in the token-resolved hue on the background fill
// (the design's input body is drawn over the terminal background, not a surface).
describe("Input component (design-system §3.2)", () => {
  test("paints the value in the foreground token on the background", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 })
    open = handle
    handle.mount(<Input id="name" value="alice" placeholder="type here" />)
    await handle.render()
    const run = findRun(handle.capture(), "alice")
    expect(run?.text).toContain("alice")
    expect((run?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foreground)
    expect((run?.bg as { rgb: string }).rgb).toBe(themeTokens("dark-default").background)
  })

  test("paints the placeholder in the faint token when the value is empty", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 })
    open = handle
    handle.mount(<Input id="name" placeholder="type here" />)
    await handle.render()
    const run = findRun(handle.capture(), "type here")
    expect(run?.text).toContain("type here")
    expect((run?.fg as { rgb: string }).rgb).toBe(themeTokens("dark-default").foregroundFaint)
  })

  test("mounts and renders a frame when focused (no hang on teardown)", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 1 })
    open = handle
    handle.mount(<Input id="name" value="hi" focused onChange={() => {}} />)
    await handle.render()
    expect(handle.capture().rows.length).toBeGreaterThan(0)
  })
})

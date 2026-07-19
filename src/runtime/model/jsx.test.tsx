import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "host/render/types"
import type { StyledRun } from "host/protocol"
import { createHeadlessRenderer } from "host/render/model/renderer"
import { Fragment, jsx, jsxDEV, jsxs } from "./jsx"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("")

describe("facade JSX helper surface (§3.2)", () => {
  test("jsx / jsxs / jsxDEV / Fragment are the facade's own callable/value re-exports", () => {
    expect(typeof jsx).toBe("function")
    expect(typeof jsxs).toBe("function")
    expect(typeof jsxDEV).toBe("function")
    expect(Fragment).toBeDefined()
  })

  test("an element built with js(x) renders through the host harness", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 1 })
    open = handle
    // jsx(type, config[, key]) — the automatic-runtime factory the compiler calls.
    handle.mount(jsx("text", { children: "hi jsx" }))
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("hi jsx")
  })
})

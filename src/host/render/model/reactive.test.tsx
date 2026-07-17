/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import { atom } from "@reatom/core"
import { reatomComponent } from "@reatom/react"

import type { RenderHandle } from "../types"
import { createHeadlessRenderer } from "./renderer"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("")

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("reatomComponent reactivity (production mount path)", () => {
  test("an atom write reaches the frame after a microtask tick, no act()", async () => {
    const counter = atom(0, "render-test.counter")
    const Counter = reatomComponent(
      () => <text>{`n=${counter()}`}</text>,
      "render-test.Counter",
    )

    const handle = await createHeadlessRenderer({ w: 12, h: 1 })
    open = handle
    handle.mount(<Counter />)
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("n=0")

    counter.set(1)
    await tick()
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("n=1")
  })
})

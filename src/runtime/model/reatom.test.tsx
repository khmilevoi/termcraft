/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"

import type { RenderHandle } from "../../host/render/types"
import { createHeadlessRenderer } from "../../host/render/model/renderer"
import { action, atom, computed, reatomComponent, wrap } from "./reatom"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("")
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("@termcraft/runtime Reatom facade re-exports", () => {
  test("atom / computed / action re-exports keep Reatom semantics under the facade", () => {
    const count = atom(2, "reatom-facade.count")
    const doubled = computed(() => count() * 2, "reatom-facade.doubled")
    expect(count()).toBe(2)
    expect(doubled()).toBe(4)

    const bump = action(() => count.set(count() + 1), "reatom-facade.bump")
    bump()
    expect(count()).toBe(3)
    expect(doubled()).toBe(6)
  })

  test("wrap is re-exported and callable at an async boundary", async () => {
    const value = await wrap(Promise.resolve("ok"))
    expect(value).toBe("ok")
  })

  test("reatomComponent from the facade renders reactively through the host harness (Spike D path)", async () => {
    const visits = atom(0, "reatom-facade.visits")
    const Visits = reatomComponent(() => <text>{`visits=${visits()}`}</text>, "reatom-facade.Visits")

    const handle = await createHeadlessRenderer({ w: 16, h: 1 })
    open = handle
    handle.mount(<Visits />)
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("visits=0")

    visits.set(7)
    await tick()
    await handle.render()
    expect(lineText(handle.capture(), 0)).toContain("visits=7")
  })
})

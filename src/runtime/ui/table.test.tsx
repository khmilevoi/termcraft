/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test"
import type { RenderHandle } from "../../host/render/types"
import type { StyledRun } from "../../host/protocol"
import { createHeadlessRenderer } from "../../host/render/model/renderer"
import { Table } from "./table"

let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

const lineRuns = (frame: { rows: StyledRun[][] }, row: number): StyledRun[] => frame.rows[row] ?? []
const lineText = (frame: { rows: StyledRun[][] }, row: number) => lineRuns(frame, row).map((run) => run.text).join("")

const COLUMNS = [
  { id: "name", label: "Name", width: 6 },
  { id: "role", label: "Role" },
]
const ROWS = [
  { id: "r1", cells: ["Alice", "Engineer"] },
  { id: "r2", cells: ["Bob", "PM"] },
]

describe("Table component (design-system §3.2)", () => {
  test("renders a header label and a body cell", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 3 })
    open = handle
    handle.mount(<Table id="team" columns={COLUMNS} rows={ROWS} />)
    await handle.render()
    const frame = handle.capture()
    expect(lineText(frame, 0)).toContain("Name")
    expect(lineText(frame, 0)).toContain("Role")
    expect(lineText(frame, 1)).toContain("Alice")
    expect(lineText(frame, 1)).toContain("Engineer")
  })

  test("a cell longer than its column width is truncated to that width", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 })
    open = handle
    handle.mount(
      <Table
        id="team"
        columns={[{ id: "name", label: "Name", width: 4 }]}
        rows={[{ id: "r1", cells: ["Alexander"] }]}
      />,
    )
    await handle.render()
    const cell = lineRuns(handle.capture(), 1).find((run) => run.text.startsWith("Alex"))
    expect(cell?.text).toBe("Alex")
  })

  test("a cell shorter than its column width is padded to that width", async () => {
    const handle = await createHeadlessRenderer({ w: 24, h: 2 })
    open = handle
    handle.mount(
      <Table
        id="team"
        columns={[{ id: "name", label: "Name", width: 6 }]}
        rows={[{ id: "r1", cells: ["Bob"] }]}
      />,
    )
    await handle.render()
    const cell = lineRuns(handle.capture(), 1).find((run) => run.text.startsWith("Bob"))
    expect(cell?.text).toBe("Bob   ")
    expect(cell?.text.length).toBe(6)
  })
})

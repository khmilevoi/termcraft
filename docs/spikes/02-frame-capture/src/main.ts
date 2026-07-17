// Spike B — styled cell-frame capture from the OpenTUI headless renderer.
// Throwaway probe. Never imported by product code.
// try/catch is permitted here per the controller's spike exemption.

import { createTestRenderer } from "@opentui/core/testing"
import { Text, TextAttributes, RGBA, vstyles } from "@opentui/core"
import type { CapturedFrame } from "@opentui/core"

const COMPILED = typeof (Bun as any).embeddedFiles !== "undefined" &&
  (Bun as any).embeddedFiles.length > 0

console.log("=== RUNTIME ===")
console.log("bun version:", Bun.version)
console.log("execPath:", process.execPath)
console.log("isCompiledBinary:", COMPILED)
console.log("embeddedFiles:", ((Bun as any).embeddedFiles ?? []).length)
console.log("platform:", process.platform, process.arch)
console.log("stdout.isTTY:", process.stdout.isTTY === true)

// ---------------------------------------------------------------- STEP 2
// Baseline: headless render, no TTY, fixed size.
console.log("")
console.log("=== STEP 2: BASELINE (40x10) ===")
{
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 40,
    height: 10,
  })
  renderer.root.add(Text({ content: "Hello" }))
  await renderOnce()

  console.log("--- captureCharFrame ---")
  console.log(captureCharFrame())

  const mod = await import("@opentui/core/testing")
  console.log("--- testing exports ---")
  console.log(Object.keys(mod).join(", "))
  renderer.destroy()
}

// ---------------------------------------------------------------- STEP 3
// What carries style?
console.log("")
console.log("=== STEP 3: WHAT CARRIES STYLE ===")
{
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 20,
    height: 3,
  })
  renderer.root.add(
    Text({
      content: "AB",
      fg: "#FF0000",
      bg: "#0000FF",
      attributes: TextAttributes.BOLD,
    }),
  )
  await renderOnce()
  const frame = captureSpans()

  console.log("--- captureSpans() raw JSON (fg/bg are RGBA class instances) ---")
  console.log(JSON.stringify(frame, null, 2).split("\n").slice(0, 34).join("\n"))

  console.log("--- decoded line 0 ---")
  for (const span of frame.lines[0]!.spans) {
    console.log(
      JSON.stringify({
        text: span.text,
        width: span.width,
        attributes: span.attributes,
        fg: span.fg.toInts(),
        fgIntent: span.fg.intent,
        bg: span.bg.toInts(),
        bgIntent: span.bg.intent,
      }),
    )
  }
  renderer.destroy()
}

// Which attributes survive?
console.log("")
console.log("--- attribute round-trip ---")
console.log("TextAttributes =", JSON.stringify(TextAttributes))
{
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 30,
    height: 10,
  })
  const names = [
    "BOLD", "DIM", "ITALIC", "UNDERLINE",
    "BLINK", "INVERSE", "HIDDEN", "STRIKETHROUGH",
  ] as const
  for (const n of names) {
    renderer.root.add(Text({ content: n, attributes: (TextAttributes as any)[n] }))
  }
  await renderOnce()
  const f = captureSpans()
  for (let i = 0; i < names.length; i++) {
    const sent = (TextAttributes as any)[names[i]!]
    const got = f.lines[i]!.spans[0]!.attributes
    console.log(
      `${names[i]!.padEnd(14)} sent=${String(sent).padStart(3)} got=${String(got).padStart(3)} match=${sent === got}`,
    )
  }
  const combo = TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE
  renderer.destroy()

  const r2 = await createTestRenderer({ width: 30, height: 3 })
  r2.renderer.root.add(Text({ content: "combo", attributes: combo }))
  await r2.renderOnce()
  const gotCombo = r2.captureSpans().lines[0]!.spans[0]!.attributes
  console.log(`COMBINED(B|I|U) sent=${combo} got=${gotCombo} match=${combo === gotCombo}`)
  r2.renderer.destroy()
}

// Are colors RGB, palette indices, or strings?
console.log("")
console.log("--- color representation ---")
{
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 20,
    height: 3,
  })
  renderer.root.add(Text({ content: "idx", fg: RGBA.fromIndex(9) }))
  await renderOnce()
  const f = captureSpans()
  const s = f.lines[0]!.spans[0]!
  console.log(
    "RGBA.fromIndex(9) ->",
    JSON.stringify({ intent: s.fg.intent, slot: s.fg.slot, ints: s.fg.toInts() }),
  )
  const blank = f.lines[1]!.spans[0]!
  console.log(
    "blank cell ->",
    JSON.stringify({
      fgIntent: blank.fg.intent, fg: blank.fg.toInts(),
      bgIntent: blank.bg.intent, bg: blank.bg.toInts(),
    }),
  )
  renderer.destroy()
}

// ------------------------------------------------ THE VERDICT QUESTION
// Can a full 80x24 styled grid be reconstructed losslessly from captureSpans()?
// Method: expand spans into per-cell records, then verify the reconstructed
// chars byte-for-byte against captureCharFrame(), which is the renderer's own
// view of the grid. Agreement on all 1920 cells is the evidence.
console.log("")
console.log("=== VERDICT PROBE: lossless 80x24 reconstruction ===")

interface Cell {
  char: string
  fg: [number, number, number, number]
  bg: [number, number, number, number]
  attributes: number
}

// Expand run-length spans into a per-cell grid. Wide chars occupy >1 column,
// so a span's `width` is not its codepoint count; trailing columns of a wide
// char are emitted as continuation cells ("").
function expand(frame: CapturedFrame): Cell[][] {
  const grid: Cell[][] = []
  for (const line of frame.lines) {
    const row: Cell[] = []
    for (const span of line.spans) {
      const style = {
        fg: span.fg.toInts(),
        bg: span.bg.toInts(),
        attributes: span.attributes,
      }
      const chars = [...span.text]
      const totalCp = chars.reduce((a, c) => a + Bun.stringWidth(c), 0)
      for (const ch of chars) {
        const w = Bun.stringWidth(ch)
        row.push({ char: ch, ...style } as Cell)
        for (let k = 1; k < w; k++) row.push({ char: "", ...style } as Cell)
      }
      // record any disagreement between the span's declared width and the
      // width we re-derived; a mismatch would mean expansion is not mechanical
      if (totalCp !== span.width) {
        console.log(
          `  !! width mismatch: span.width=${span.width} derived=${totalCp} text=${JSON.stringify(span.text)}`,
        )
      }
    }
    grid.push(row)
  }
  return grid
}

{
  const { renderer, renderOnce, captureSpans, captureCharFrame } =
    await createTestRenderer({ width: 80, height: 24 })

  renderer.root.add(
    Text(
      {},
      vstyles.fg("#FF0000", "RED"),
      vstyles.bg("#00FF00", "GRN"),
      vstyles.bold("BOLD"),
      vstyles.italic("ITAL"),
      // NB: children are typed `VChild[] | TextNodeRenderable[]` — a union, not a
      // mix. A bare string alongside vstyles nodes throws "mount() received an
      // invalid vnode", so unstyled text must still be wrapped in a text node.
      vstyles.styled(TextAttributes.NONE, "plain 日本語 tail"),
    ),
  )
  await renderOnce()

  const frame = captureSpans()
  const grid = expand(frame)

  console.log("cols =", frame.cols, " rows =", frame.rows, " lines =", frame.lines.length)
  console.log("cursor =", JSON.stringify(frame.cursor))

  // 1. every row must tile to exactly `cols`
  const tiling = frame.lines.map((l) => l.spans.reduce((a, s) => a + s.width, 0))
  const allTile = tiling.every((t) => t === frame.cols)
  console.log("all rows tile to cols:", allTile, " widths:", JSON.stringify([...new Set(tiling)]))

  // 2. expanded grid must be exactly 24 rows x 80 cells
  const dims = grid.map((r) => r.length)
  const dimsOk = grid.length === 24 && dims.every((d) => d === 80)
  console.log("grid is 24x80:", dimsOk, " row lengths:", JSON.stringify([...new Set(dims)]))

  // 3. reconstructed chars must equal captureCharFrame() exactly
  const rebuilt = grid.map((row) => row.map((c) => c.char).join("")).join("\n")
  const truth = captureCharFrame().replace(/\n$/, "")
  const identical = rebuilt === truth
  console.log("reconstructed chars === captureCharFrame():", identical)
  if (!identical) {
    console.log("  rebuilt[0] =", JSON.stringify(rebuilt.split("\n")[0]))
    console.log("  truth[0]   =", JSON.stringify(truth.split("\n")[0]))
  }

  console.log("LOSSLESS =", allTile && dimsOk && identical)
  console.log("--- sample styled cells from row 0 (char + fg + bg + attributes) ---")
  for (const i of [0, 3, 6, 10, 14, 20]) {
    const c = grid[0]![i]!
    console.log(
      `  cell[0][${String(i).padStart(2)}] = ${JSON.stringify(c.char)} fg=${JSON.stringify(c.fg)} bg=${JSON.stringify(c.bg)} attr=${c.attributes}`,
    )
  }
  renderer.destroy()
}

// ---------------------------------------------------------------- STEP 5
console.log("")
console.log("=== STEP 5: RESIZE / MOUSE / TIMING ===")

// resize tracking
{
  const { renderer, renderOnce, captureSpans, captureCharFrame, resize } =
    await createTestRenderer({ width: 80, height: 24 })
  renderer.root.add(Text({ content: "resize-probe" }))
  await renderOnce()
  const before = captureSpans()
  console.log(
    `before: cols=${before.cols} rows=${before.rows} lines=${before.lines.length} charFrameLines=${captureCharFrame().replace(/\n$/, "").split("\n").length}`,
  )

  resize(120, 40)
  await renderOnce()
  const after = captureSpans()
  const charLines = captureCharFrame().replace(/\n$/, "").split("\n")
  console.log(
    `after resize(120,40): cols=${after.cols} rows=${after.rows} lines=${after.lines.length} charFrameLines=${charLines.length} firstLineWidth=${charLines[0]!.length}`,
  )
  const tiles = after.lines.every(
    (l) => l.spans.reduce((a, s) => a + s.width, 0) === after.cols,
  )
  console.log(
    "resize tracked:",
    after.cols === 120 && after.rows === 40 && after.lines.length === 40 && tiles,
  )
  renderer.destroy()
}

// mockMouse hit resolution
{
  const { renderer, renderOnce, mockMouse } = await createTestRenderer({
    width: 40,
    height: 10,
  })
  const hits: string[] = []
  const box = Text({
    content: "CLICK-TARGET",
    onMouseDown: () => hits.push("mousedown"),
    onMouseUp: () => hits.push("mouseup"),
  })
  renderer.root.add(box)
  await renderOnce()

  try {
    await mockMouse.click(3, 0)
    await renderOnce()
    console.log("mockMouse.click(3,0) -> handlers fired:", JSON.stringify(hits))
    console.log("mouse position:", JSON.stringify(mockMouse.getCurrentPosition()))
    console.log("hit resolved:", hits.length > 0)
  } catch (e) {
    console.log("mockMouse FAILED:", (e as Error).message)
  }
  renderer.destroy()
}

// wall-clock: createTestRenderer + renderOnce + capture at 80x24
{
  console.log("--- timing: createTestRenderer + renderOnce + capture @ 80x24 ---")
  const runs: number[] = []
  const parts: string[] = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({
      width: 80,
      height: 24,
    })
    const t1 = performance.now()
    renderer.root.add(Text({ content: "timing", fg: "#FF0000" }))
    await renderOnce()
    const t2 = performance.now()
    captureSpans()
    const t3 = performance.now()
    renderer.destroy()
    runs.push(t3 - t0)
    parts.push(
      `run${i}: total=${(t3 - t0).toFixed(2)}ms (create=${(t1 - t0).toFixed(2)} render=${(t2 - t1).toFixed(2)} capture=${(t3 - t2).toFixed(2)})`,
    )
  }
  for (const p of parts) console.log(p)
  const sorted = [...runs].sort((a, b) => a - b)
  console.log(
    `min=${sorted[0]!.toFixed(2)}ms median=${sorted[2]!.toFixed(2)}ms max=${sorted[4]!.toFixed(2)}ms`,
  )
}

// ---------------------------------------------------------------- STEP 6
// Is there a headless path that does NOT import @opentui/core/testing?
// createTestRenderer is a thin harness: setupTestRenderer does
//   new CliRenderer(stdin, stdout, w, h, { bufferedOutput: "memory" })
// and captureSpans() is
//   { cols, rows, cursor: getCursorState(), lines: currentRenderBuffer.getSpanLines() }
// Every one of those members is on the PUBLIC surface. Rebuild it and compare.
console.log("")
console.log("=== STEP 6: /testing-free headless path (public API only) ===")
{
  const { CliRenderer, Text: T2 } = await import("@opentui/core")
  const { Writable, Readable } = await import("node:stream")

  class FakeStdout extends Writable {
    isTTY = true
    columns = 80
    rows = 24
    _write(_c: any, _e: any, cb: () => void) {
      cb()
    }
    getColorDepth() {
      return 24
    }
  }
  const fakeStdin = new Readable({ read() {} }) as any
  fakeStdin.isTTY = true
  fakeStdin.setRawMode = () => fakeStdin
  const fakeStdout = new FakeStdout() as any

  try {
    const renderer = new CliRenderer(fakeStdin, fakeStdout, 80, 24, {
      bufferedOutput: "memory",
      screenMode: "main-screen",
      consoleMode: "disabled",
      externalOutputMode: "passthrough",
      useMouse: false,
      exitOnCtrlC: false,
    })
    renderer.root.add(
      T2({ content: "PUBLIC", fg: "#FF0000", bg: "#0000FF", attributes: TextAttributes.BOLD }),
    )
    await renderer.loop()

    const buf = renderer.currentRenderBuffer
    const lines = buf.getSpanLines()
    const cursor = renderer.getCursorState()
    const frame: CapturedFrame = {
      cols: buf.width,
      rows: buf.height,
      cursor: [cursor.x, cursor.y],
      lines,
    }
    const s = frame.lines[0]!.spans[0]!
    console.log("createCliRenderer/CliRenderer headless: OK")
    console.log(
      "public getSpanLines() span[0] =",
      JSON.stringify({
        text: s.text,
        width: s.width,
        attributes: s.attributes,
        fg: s.fg.toInts(),
        bg: s.bg.toInts(),
      }),
    )
    const tiles = frame.lines.every(
      (l) => l.spans.reduce((a, x) => a + x.width, 0) === frame.cols,
    )
    console.log(
      `frame cols=${frame.cols} rows=${frame.rows} lines=${frame.lines.length} tiles=${tiles}`,
    )
    console.log(
      "raw per-cell typed arrays via buf.buffers:",
      JSON.stringify({
        char: buf.buffers.char.length,
        fg: buf.buffers.fg.length,
        bg: buf.buffers.bg.length,
        attributes: buf.buffers.attributes.length,
        expectedCells: 80 * 24,
      }),
    )
    console.log("STEP6_TESTING_FREE_PATH_WORKS = true")
    renderer.destroy()
  } catch (e) {
    console.log("STEP6_TESTING_FREE_PATH_WORKS = false")
    console.log("error:", (e as Error).message)
  }
}

console.log("")
console.log("=== PROBE COMPLETE ===")

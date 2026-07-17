// Spike B — styled cell-frame capture from the OpenTUI headless renderer.
// Throwaway probe. Never imported by product code.
// try/catch is permitted here per the controller's spike exemption.

import { createTestRenderer } from "@opentui/core/testing"
import {
  Text,
  TextAttributes,
  RGBA,
  vstyles,
  getBaseAttributes,
  attributesWithLink,
  getLinkId,
  ATTRIBUTE_BASE_MASK,
} from "@opentui/core"
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
      // NB: accumulates DISPLAY width (not codepoint count) — `日` counts 2.
      const derivedWidth = chars.reduce((a, c) => a + Bun.stringWidth(c), 0)
      for (const ch of chars) {
        const w = Bun.stringWidth(ch)
        row.push({ char: ch, ...style } as Cell)
        for (let k = 1; k < w; k++) row.push({ char: "", ...style } as Cell)
      }
      // record any disagreement between the span's declared width and the
      // width we re-derived; a mismatch would mean expansion is not mechanical
      if (derivedWidth !== span.width) {
        console.log(
          `  !! width mismatch: span.width=${span.width} derived=${derivedWidth} text=${JSON.stringify(span.text)}`,
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

  // 4. THE STYLE CHECK — a PRE-IMAGE ROUND-TRIP, not an independent witness.
  // Checks 1-3 are char/structural only: none compares a single fg/bg/attribute
  // value against anything. This one does. But be precise about what it proves:
  // getSpanLines() is implemented ON TOP of buffers (chunk-bun-t2myhmwd.js:10583
  // destructures `this.buffers`) and decodes colour with the SAME
  // RGBA.fromArray(fg.slice(i*4, i*4+4)) call used below (:10598-10599). So this
  // compares the RLE against its own pre-image: it catches column misassignment
  // in the wcwidth expansion — the real risk — but a systematic decoder error
  // would cancel on both sides and still print 0 mismatches.
  const buf = renderer.currentRenderBuffer
  const raw = buf.buffers
  let styleMismatches = 0
  const firstMismatches: string[] = []
  for (let y = 0; y < frame.rows; y++) {
    for (let x = 0; x < frame.cols; x++) {
      const i = y * frame.cols + x
      const cell = grid[y]![x]!
      // raw fg/bg are 4×Uint16 per cell in the SAME packed encoding as
      // RGBA.buffer, so decode via RGBA.fromArray before comparing.
      const rawFg = RGBA.fromArray(raw.fg.slice(i * 4, i * 4 + 4)).toInts()
      const rawBg = RGBA.fromArray(raw.bg.slice(i * 4, i * 4 + 4)).toInts()
      // attributes[i] is a u32: low 8 bits are text attributes, upper bits carry
      // a hyperlink id. getSpanLines masks `& 255` (:10600); getBaseAttributes()
      // is the package's public accessor for exactly this.
      const rawAttr = getBaseAttributes(raw.attributes[i]!)
      const fgOk = rawFg.join(",") === cell.fg.join(",")
      const bgOk = rawBg.join(",") === cell.bg.join(",")
      const attrOk = rawAttr === cell.attributes
      if (!fgOk || !bgOk || !attrOk) {
        styleMismatches++
        if (firstMismatches.length < 5) {
          firstMismatches.push(
            `    [${y}][${x}] span fg=${JSON.stringify(cell.fg)} bg=${JSON.stringify(cell.bg)} attr=${cell.attributes}` +
              ` vs raw fg=${JSON.stringify(rawFg)} bg=${JSON.stringify(rawBg)} attr=${rawAttr}`,
          )
        }
      }
    }
  }
  const styleOk = styleMismatches === 0
  console.log(
    `per-cell style vs buffers oracle: ${frame.cols * frame.rows} cells checked, ${styleMismatches} mismatches -> ${styleOk}`,
  )
  for (const m of firstMismatches) console.log(m)

  // LOSSLESS now includes a measured style comparison, not just chars/geometry.
  console.log("LOSSLESS =", allTile && dimsOk && identical && styleOk)
  console.log(
    "  (allTile=%s dimsOk=%s charsIdentical=%s styleMatchesOracle=%s)",
    allTile,
    dimsOk,
    identical,
    styleOk,
  )

  console.log("--- sample styled cells from row 0: expanded span vs raw buffers ---")
  for (const i of [0, 3, 6, 10, 14, 20]) {
    const c = grid[0]![i]!
    const rawFg = RGBA.fromArray(raw.fg.slice(i * 4, i * 4 + 4)).toInts()
    const rawBg = RGBA.fromArray(raw.bg.slice(i * 4, i * 4 + 4)).toInts()
    console.log(
      `  cell[0][${String(i).padStart(2)}] = ${JSON.stringify(c.char)} fg=${JSON.stringify(c.fg)} bg=${JSON.stringify(c.bg)} attr=${c.attributes}` +
        ` || raw fg=${JSON.stringify(rawFg)} bg=${JSON.stringify(rawBg)} attr=${raw.attributes[i]}`,
    )
  }
  renderer.destroy()
}

// ------------------------------------------------ .buffers ENCODING
// The recommendation to prefer `.buffers` for the host protocol must not rest
// on array LENGTHS (which are arithmetic from the allocation). Read actual
// values and find out what the encoding really is.
console.log("")
console.log("=== .buffers ENCODING: actual values, not lengths ===")
{
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 10,
    height: 2,
  })
  renderer.root.add(
    Text({ content: "A日b", fg: "#FF0000", bg: "#0000FF", attributes: TextAttributes.BOLD }),
  )
  await renderOnce()
  const raw = renderer.currentRenderBuffer.buffers
  const span0 = captureSpans().lines[0]!.spans[0]!
  console.log(
    "array types:",
    JSON.stringify({
      char: raw.char.constructor.name,
      fg: raw.fg.constructor.name,
      bg: raw.bg.constructor.name,
      attributes: raw.attributes.constructor.name,
    }),
  )
  console.log(
    "span0:",
    JSON.stringify({ text: span0.text, fg: span0.fg.toInts(), bg: span0.bg.toInts(), attr: span0.attributes }),
  )
  const decode = (v: number) => {
    try {
      return JSON.stringify(String.fromCodePoint(v))
    } catch (e) {
      return `<NOT A CODEPOINT: ${(e as Error).message}>`
    }
  }
  console.log('rendering "A日b" (日 is U+65E5, display width 2):')
  for (let x = 0; x < 5; x++) {
    console.log(
      `  cell[0][${x}] char=${String(raw.char[x]).padStart(10)} 0x${raw.char[x]!.toString(16).padStart(8, "0")} ${decode(raw.char[x]!)}` +
        ` fg=[${raw.fg[x * 4]},${raw.fg[x * 4 + 1]},${raw.fg[x * 4 + 2]},${raw.fg[x * 4 + 3]}] attr=${raw.attributes[x]}`,
    )
  }
  renderer.destroy()
}
{
  // Does colour INTENT/SLOT survive in the flat Uint16Array?
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 10,
    height: 2,
  })
  renderer.root.add(Text({ content: "X", fg: RGBA.fromIndex(9) }))
  await renderOnce()
  const raw = renderer.currentRenderBuffer.buffers
  const s = captureSpans().lines[0]!.spans[0]!
  console.log("indexed colour RGBA.fromIndex(9):")
  console.log(
    "  span fg  ->",
    JSON.stringify({ intent: s.fg.intent, slot: s.fg.slot, ints: s.fg.toInts() }),
    " .buffer raw =",
    JSON.stringify(Array.from(s.fg.buffer)),
  )
  console.log("  raw buffers fg cell0 =", JSON.stringify([raw.fg[0], raw.fg[1], raw.fg[2], raw.fg[3]]))
  const rebuilt = RGBA.fromArray(raw.fg.slice(0, 4))
  console.log(
    "  RGBA.fromArray(raw slice) ->",
    JSON.stringify({ intent: rebuilt.intent, slot: rebuilt.slot, ints: rebuilt.toInts() }),
  )
  renderer.destroy()
}
{
  // Are `attributes` really a "plain bitmask"? The upper bits carry a link id
  // (utils.d.ts: attributesWithLink / getLinkId), and getSpanLines masks & 255.
  // A frame with no hyperlinks cannot tell you this — so put one in.
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 12,
    height: 2,
  })
  const packed = attributesWithLink(TextAttributes.BOLD, 7)
  renderer.root.add(Text({ content: "L", attributes: packed }))
  await renderOnce()
  const raw = renderer.currentRenderBuffer.buffers
  const spanAttr = captureSpans().lines[0]!.spans[0]!.attributes
  console.log("attributes: is it a plain bitmask? (ATTRIBUTE_BASE_MASK =", ATTRIBUTE_BASE_MASK, ")")
  console.log(
    "  attributesWithLink(BOLD=1, linkId=7) =",
    packed,
    `0x${packed.toString(16)}  -> getLinkId=${getLinkId(packed)} getBaseAttributes=${getBaseAttributes(packed)}`,
  )
  console.log(
    "  raw buffers attributes[0] =",
    raw.attributes[0],
    `0x${raw.attributes[0]!.toString(16)}  -> getBaseAttributes=${getBaseAttributes(raw.attributes[0]!)} getLinkId=${getLinkId(raw.attributes[0]!)}`,
  )
  console.log(
    "  span attributes =",
    spanAttr,
    " (getSpanLines masks & 255, so the link id is DROPPED from spans)",
  )
  console.log(
    "  raw === span?",
    raw.attributes[0] === spanAttr,
    " getBaseAttributes(raw) === span?",
    getBaseAttributes(raw.attributes[0]!) === spanAttr,
  )
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
// BUT the harness's renderOnce() drives the frame via `renderer.loop()` and
// `renderer._feed`, and BOTH are declared private (renderer.d.ts:559, :331).
// So the naive rebuild is NOT "public API only". Enumerate the render routes and
// find out which public one actually paints a styled frame.
console.log("")
console.log("=== STEP 6: /testing-free headless path ===")

// Fake TTY streams. NB: isTTY must be true — CliRenderer branches on it.
async function makeFakeStreams(cols: number, rows: number) {
  const { Writable, Readable } = await import("node:stream")
  class FakeStdout extends Writable {
    isTTY = true
    columns = cols
    rows = rows
    _write(_c: any, _e: any, cb: () => void) {
      cb()
    }
    getColorDepth() {
      return 24
    }
  }
  const stdin = new Readable({ read() {} }) as any
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  return { stdin, stdout: new FakeStdout() as any }
}

// Which render entry points are public, and which actually paint?
console.log("--- render route survey (does it paint a styled frame?) ---")
{
  const { CliRenderer: CR, Text: T3 } = await import("@opentui/core")
  const routes: Array<[string, string, (r: any) => Promise<void> | void]> = [
    ["intermediateRender()", "PUBLIC  renderer.d.ts:560", (r) => r.intermediateRender()],
    ["requestRender() only", "PUBLIC  renderer.d.ts:388", (r) => r.requestRender()],
    [
      "requestRender() + await tick",
      "PUBLIC  renderer.d.ts:388",
      async (r) => {
        r.requestRender()
        await new Promise((res) => setTimeout(res, 60))
      },
    ],
    [
      "start() + tick + stop()",
      "PUBLIC  renderer.d.ts:545/552",
      async (r) => {
        r.start()
        await new Promise((res) => setTimeout(res, 80))
        r.stop()
      },
    ],
    [
      "intermediateRender()+await idle()",
      "PUBLIC  renderer.d.ts:560+395",
      async (r) => {
        r.intermediateRender()
        await r.idle()
      },
    ],
    ["loop()", "PRIVATE renderer.d.ts:559", async (r) => await r.loop()],
  ]
  for (const [name, vis, drive] of routes) {
    const { stdin, stdout } = await makeFakeStreams(20, 3)
    try {
      const r = new CR(stdin, stdout, 20, 3, {
        bufferedOutput: "memory",
        screenMode: "main-screen",
        consoleMode: "disabled",
        externalOutputMode: "passthrough",
        useMouse: false,
        exitOnCtrlC: false,
      })
      r.root.add(T3({ content: "PUB", fg: "#FF0000", attributes: TextAttributes.BOLD }))
      await drive(r)
      const s = r.currentRenderBuffer.getSpanLines()[0]?.spans[0]
      const txt = s ? s.text : "(none)"
      const painted = txt.trimEnd() === "PUB" || txt.startsWith("PUB")
      console.log(
        `  ${name.padEnd(29)} ${vis.padEnd(25)} painted=${String(painted).padEnd(5)} span0=${JSON.stringify(txt)} attr=${s?.attributes}`,
      )
      r.destroy()
    } catch (e) {
      console.log(`  ${name.padEnd(29)} ${vis.padEnd(25)} THREW: ${(e as Error).message}`)
    }
  }
}

// Is intermediateRender() actually synchronous, or is that a property of an
// empty frameCallbacks list? intermediateRender() sets a flag then calls the
// ASYNC loop() without awaiting it (chunk-bun-tkm837n2.js:9696-9699), and loop()
// awaits each registered frameCallback. setFrameCallback is public (:540).
console.log("--- is intermediateRender() synchronous? (frameCallback probe) ---")
{
  const { CliRenderer: CR, Text: T4 } = await import("@opentui/core")
  for (const withCb of [false, true]) {
    const { stdin, stdout } = await makeFakeStreams(20, 3)
    const r = new CR(stdin, stdout, 20, 3, {
      bufferedOutput: "memory",
      screenMode: "main-screen",
      consoleMode: "disabled",
      externalOutputMode: "passthrough",
      useMouse: false,
      exitOnCtrlC: false,
    })
    r.root.add(T4({ content: "PUB", fg: "#FF0000", attributes: TextAttributes.BOLD }))
    if (withCb) {
      r.setFrameCallback(async () => {
        await new Promise((res) => setTimeout(res, 50))
      })
    }
    r.intermediateRender()
    const immediate = r.currentRenderBuffer.getSpanLines()[0]?.spans[0]?.text ?? "(none)"
    await r.idle()
    const afterIdle = r.currentRenderBuffer.getSpanLines()[0]?.spans[0]?.text ?? "(none)"
    console.log(
      `  frameCallback registered=${String(withCb).padEnd(5)} -> painted immediately after intermediateRender()=${String(immediate.startsWith("PUB")).padEnd(5)}` +
        ` | after await idle()=${afterIdle.startsWith("PUB")}`,
    )
    r.destroy()
  }
  console.log(
    "  => intermediateRender() is synchronous ONLY while frameCallbacks is empty; await idle() covers both.",
  )
}

// Rebuild the full path using ONLY public members, via the entry point the
// package tells production to use (renderer.d.ts:358-360 warns the raw ctor does
// not roll back late side effects if construction throws).
console.log("--- full rebuild: createCliRenderer + intermediateRender() + await idle() ---")
{
  const { createCliRenderer, Text: T2 } = await import("@opentui/core")
  const { stdin: fakeStdin, stdout: fakeStdout } = await makeFakeStreams(80, 24)

  try {
    const renderer = await createCliRenderer({
      stdin: fakeStdin,
      stdout: fakeStdout,
      width: 80,
      height: 24,
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
    renderer.intermediateRender() // PUBLIC renderer.d.ts:560
    await renderer.idle() // PUBLIC renderer.d.ts:395 — covers frameCallbacks AND backpressure

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
    console.log("createCliRenderer headless (recommended production ctor): OK")
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
    // lengths are arithmetic from the allocation; VALUES are the observation.
    const raw = buf.buffers
    console.log(
      "buf.buffers lengths:",
      JSON.stringify({
        char: raw.char.length,
        fg: raw.fg.length,
        bg: raw.bg.length,
        attributes: raw.attributes.length,
        expectedCells: 80 * 24,
      }),
    )
    console.log(
      "buf.buffers VALUES cell[0][0..5]:",
      JSON.stringify(
        [0, 1, 2, 3, 4, 5].map((i) => ({
          char: raw.char[i],
          fg: RGBA.fromArray(raw.fg.slice(i * 4, i * 4 + 4)).toInts(),
          attr: raw.attributes[i],
        })),
      ),
    )
    console.log("STEP6_TESTING_FREE_PATH_WORKS_PUBLIC_ONLY = true")
    renderer.destroy()
  } catch (e) {
    console.log("STEP6_TESTING_FREE_PATH_WORKS_PUBLIC_ONLY = false")
    console.log("error:", (e as Error).message)
  }
}

console.log("")
console.log("=== PROBE COMPLETE ===")

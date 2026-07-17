// Diagnostic-only, not part of the committed probe: does the PRODUCTION
// mount path (createCliRenderer + @opentui/react's createRoot, no
// createTestRenderer/testRender, no IS_REACT_ACT_ENVIRONMENT) suffer the
// same "setState never commits" problem as the headless test harness? This
// isolates whether the act()-environment is the cause, or whether the
// reconciler binding is broken outright. Not written to FINDINGS.md paths;
// used only to decide the verdict, then deleted before commit.

import { atom } from "@reatom/core"
import { reatomComponent } from "@reatom/react"
import { createRoot } from "@opentui/react"
import { Writable, Readable } from "node:stream"

class FakeStdout extends Writable {
  isTTY = true
  columns = 40
  rows = 6
  _write(_c: unknown, _e: unknown, cb: () => void) {
    cb()
  }
  getColorDepth() {
    return 24
  }
}

async function main() {
  const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { isTTY: boolean; setRawMode: (v: boolean) => unknown }
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdin as unknown as { setRawMode: (v: boolean) => unknown }).setRawMode = () => stdin

  const { createCliRenderer, TextRenderable } = await import("@opentui/core")
  const renderer = await createCliRenderer({
    stdin: stdin as never,
    stdout: new FakeStdout() as never,
    width: 40,
    height: 6,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    externalOutputMode: "passthrough",
    useMouse: false,
    exitOnCtrlC: false,
  })

  const counter = atom(0, "prodpath.counter")
  const Probe = reatomComponent(() => {
    const n = counter()
    return <text>{`n=${n}`}</text>
  }, "prodpath.Probe")

  const root = createRoot(renderer)
  root.render(<Probe />)
  renderer.intermediateRender()
  await renderer.idle()

  const readText = () => renderer.currentRenderBuffer.getSpanLines()[0]?.spans[0]?.text ?? "(none)"
  console.log("initial:", JSON.stringify(readText()))

  counter.set(1)
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  renderer.intermediateRender()
  await renderer.idle()
  console.log("after set(1) + intermediateRender+idle (no act):", JSON.stringify(readText()))

  counter.set(2)
  await new Promise((r) => setTimeout(r, 50))
  renderer.intermediateRender()
  await renderer.idle()
  console.log("after set(2) + 50ms wait + intermediateRender+idle:", JSON.stringify(readText()))

  renderer.destroy()
  process.exit(0)
}

main()

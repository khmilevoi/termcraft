# termcraft MVP Phase 2B — Headless Render Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/host/render/` — the headless OpenTUI render harness: create a
renderer with fake streams at a fixed size on the **public** OpenTUI API, mount a
page (a `reatomComponent` default export), render one frame, and capture it as
styled rows (`StyledRun[][]`) ready for the phase-2A `FrameEnvelope`. This is the
phase-1 unblocker — it is what finally lets the runtime component catalog be
rendered and snapshot-tested.

**Architecture:** `host/render/` is a submodule of the `host/` adapter module. It
imports `@opentui/core` (public API only — never `@opentui/core/testing` in
product code), `@opentui/react` (`createRoot`), and reuses the phase-2A
`StyledRun`/`Color` protocol types (`host/protocol`) so a captured frame drops
straight into a `FrameEnvelope`. The pure mapping functions (RGBA→Color,
attributes→mask, spanLines→rows) are unit-tested in isolation; the real render is
covered by integration tests that drive a live headless renderer.

**Tech Stack:** TypeScript 7.0.2, Bun ≥1.3.14, `@opentui/core` 0.4.5 (exact),
`@opentui/react` 0.4.5 (exact), `@reatom/core`/`@reatom/react` 1001, `react` 19,
`bun:test`. tsconfig `jsx: "react-jsx"`, `strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`.

## Global Constraints

See `2026-07-17-termcraft-mvp-roadmap.md` and `2026-07-17-mvp-phase-2-host.md` →
"Global constraints". Phase-2B-critical items:

- **Public OpenTUI API only in product code** (Spike B). `createCliRenderer`, not
  `new CliRenderer`; `intermediateRender()` **followed by `await renderer.idle()`**;
  capture via `renderer.currentRenderBuffer.getSpanLines()`. `@opentui/core/testing`
  and `@opentui/react/test-utils` may appear **only** inside `*.test.ts`, never in
  `model/` product code.
- **Frame text from the span API, never `buffers.char`** (wide chars are a packed
  non-codepoint encoding). `span.width` is **display** width, not codepoint count.
- **RGBA is a class** — read `.intent`/`.slot`/`.toInts()`/`.a`, never
  `JSON.stringify` it.
- **`attributes` needs an explicit remap, NOT `& 0x3F`** — OpenTUI `INVERSE=32`
  maps to protocol bit `16`, OpenTUI `STRIKETHROUGH=128` maps to protocol bit `32`;
  `BLINK`/`HIDDEN` have no protocol bit. Strip the hyperlink id with
  `getBaseAttributes()` first.
- **Fake stdout `columns`/`rows` OUTRANK `config.width`/`height`** — set them to the
  requested size on the shim, per render (Spike B trap).
- **`stdin.setRawMode` and `isTTY` are load-bearing** on the shims or `setupTerminal()`
  throws.
- **Production mount path needs no `act()`** (Spike D): `createRoot(renderer).render()`
  flushes Reatom writes automatically after a microtask tick. `act()` from `"react"`
  is required ONLY under the test renderer (`testRender`/`createTestRenderer`), which
  this harness does not use in product code. A reactive test on the production path
  needs a microtask/`setTimeout(0)` tick after `atom.set` before re-rendering.
- **One-shot children call `process.exit()`** after `renderer.destroy()` (Spike D) —
  but the harness LIBRARY never calls `process.exit`; the one-shot host entry (2C)
  does. In `bun test`, tests MUST NOT call `process.exit` (it kills the runner);
  they destroy the renderer and rely on clean release (see the Task 6 hang check).
- **Reuse phase-2A types:** import `StyledRun`, `Color` from `../../protocol`; do not
  redefine them.
- **Green gates after every task:** `bun test` and `bun x tsc --noEmit` both clean.

## OpenTUI recipe (verified against installed `@opentui/core@0.4.5` types + Spikes B/D)

Every fact below is confirmed against `node_modules/@opentui/core` and the proven
probes `docs/spikes/02-frame-capture/src/main.ts` and
`docs/spikes/04-reatom-opentui/src/main.tsx`.

**Renderer + capture:**
- `createCliRenderer(config): Promise<CliRenderer>`. Headless config:
  `{ stdin, stdout, width, height, bufferedOutput: "memory", screenMode:
  "main-screen", consoleMode: "disabled", externalOutputMode: "passthrough",
  useMouse: false, exitOnCtrlC: false }`. `bufferedOutput: "memory"` allocates no
  native span feed (no TTY needed).
- Render once: `renderer.intermediateRender()` then `await renderer.idle()` (both
  required; `intermediateRender` is fire-and-forget over an async loop).
- Capture: `renderer.currentRenderBuffer` (`OptimizedBuffer`) → `.getSpanLines()`
  returns `CapturedLine[]`; `.width`/`.height` give the dims.
- `CapturedSpan = { text: string; fg: RGBA; bg: RGBA; attributes: number; width: number }`;
  `CapturedLine = { spans: CapturedSpan[] }`. Spans are run-length and tile to exactly
  `width` per line.
- Teardown: `renderer.destroy()`.

**RGBA (`@opentui/core`):** class with `get intent(): "rgb"|"indexed"|"default"`,
`get slot(): number` (palette index when indexed), `toInts(): [r,g,b,a]` (0–255),
`get a(): number`. Static ctors for tests: `RGBA.fromInts(r,g,b,a?)` (intent "rgb"),
`RGBA.fromIndex(i)` (intent "indexed", slot i), `RGBA.defaultForeground()` /
`RGBA.defaultBackground()` (intent "default"). An unset cell is observed as
`intent:"rgb"` with `a === 0` (transparent) — treat `a === 0` as "default" too.

**Attributes (`@opentui/core`):** `TextAttributes` constants — `BOLD=1, DIM=2,
ITALIC=4, UNDERLINE=8, BLINK=16, INVERSE=32, HIDDEN=64, STRIKETHROUGH=128`.
`getBaseAttributes(attr)` strips the hyperlink id (`& 255`). `getSpanLines()` spans
already carry base-only attributes; `buffers.attributes` do not.

**Mount:** `import { createRoot } from "@opentui/react"`;
`createRoot(renderer).render(<Page/>)`. `Page` is a `reatomComponent` from
`@reatom/react` returning intrinsic elements (`<box>`, `<text>`). No `act()` on this
path; after `atom.set` wait one microtask tick before re-rendering.

## File Structure

```text
src/host/
  types.ts                     + Size (host-shared; append)
  render/
    model/
      color.ts                 rgbaToColor(RGBA): Color                     (Task 1)
      color.test.ts
      attributes.ts            attributesToMask(number): number             (Task 2)
      attributes.test.ts
      span-rows.ts             styledRowsFromSpanLines(CapturedLine[]): StyledRun[][] (Task 3)
      span-rows.test.ts
      streams.ts               makeHeadlessStreams(Size)                    (Task 4)
      streams.test.ts
      renderer.ts              createHeadlessRenderer(Size), renderNodeOnce (Task 5)
      renderer.test.tsx
      reactive.test.tsx        reatomComponent reactivity integration       (Task 6)
    types.ts                   CapturedFrame, RenderHandle
    index.ts
```

---

### Task 1: `rgbaToColor` — RGBA → protocol `Color`

**Files:**
- Create: `src/host/render/types.ts`
- Create: `src/host/render/model/color.ts`
- Create: `src/host/render/model/color.test.ts`
- Create: `src/host/render/index.ts`

**Interfaces:**
- Consumes: `Color` from `../../protocol`, `RGBA` from `@opentui/core`.
- Produces: `rgbaToColor(color: RGBA): Color`; `CapturedFrame`, `RenderHandle`,
  `RenderSize` (in `render/types.ts`).

- [ ] **Step 1: Write the failing test**

`src/host/render/model/color.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"

import { rgbaToColor } from "./color"

describe("rgbaToColor", () => {
  test("maps a default-intent color to \"default\"", () => {
    expect(rgbaToColor(RGBA.defaultForeground())).toBe("default")
  })

  test("maps a transparent (alpha 0) color to \"default\"", () => {
    expect(rgbaToColor(RGBA.fromInts(0, 0, 0, 0))).toBe("default")
  })

  test("maps an indexed color to { indexed: slot }", () => {
    expect(rgbaToColor(RGBA.fromIndex(9))).toEqual({ indexed: 9 })
  })

  test("maps an rgb color to lowercase #rrggbb", () => {
    expect(rgbaToColor(RGBA.fromInts(255, 136, 0))).toEqual({ rgb: "#ff8800" })
  })

  test("pads single-digit channels", () => {
    expect(rgbaToColor(RGBA.fromInts(1, 2, 3))).toEqual({ rgb: "#010203" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/color.test.ts`
Expected: FAIL — cannot resolve `./color`.

- [ ] **Step 3: Write the implementation**

`src/host/render/types.ts`:

```ts
import type { StyledRun } from "../protocol"

/** A terminal-cell size for a headless render. */
export interface RenderSize {
  readonly w: number
  readonly h: number
}

/**
 * A frame captured from the headless renderer — the styled rows plus dims, ready
 * to drop into a phase-2A `FrameEnvelope` (which adds the identity fields).
 */
export interface CapturedFrame {
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}

/** A live headless renderer with a mounted React root. */
export interface RenderHandle {
  /** Mount (or replace) the React tree to render. */
  mount(node: unknown): void
  /** Paint one frame and wait for it to settle. */
  render(): Promise<void>
  /** Capture the current frame as styled rows. */
  capture(): CapturedFrame
  /** Tear down the renderer and release native resources. */
  destroy(): void
}
```

`src/host/render/model/color.ts`:

```ts
import { RGBA } from "@opentui/core"

import type { Color } from "../../protocol"

const hexByte = (value: number) => value.toString(16).padStart(2, "0")

/**
 * Map an OpenTUI `RGBA` to the protocol `Color`. Drives off `intent`, with the
 * observed unset-cell case (transparent `a === 0`) folded into "default"
 * (Spike B: unset cells arrive as intent "rgb" with alpha 0). Indexed colors
 * keep their palette `slot`; true colors emit lowercase `#rrggbb`.
 */
export function rgbaToColor(color: RGBA): Color {
  if (color.intent === "default" || color.a === 0) return "default"
  if (color.intent === "indexed") return { indexed: color.slot }
  const [r, g, b] = color.toInts()
  return { rgb: `#${hexByte(r)}${hexByte(g)}${hexByte(b)}` }
}
```

`src/host/render/index.ts`:

```ts
export type { CapturedFrame, RenderHandle, RenderSize } from "./types"
export { rgbaToColor } from "./model/color"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `RGBA.fromInts(...).intent` is not `"rgb"` or a default
ctor's `intent` is not `"default"`, adjust the mapping conditions to match the real
class and note it — the invariant is: default/transparent → "default", indexed →
`{indexed}`, everything else → `{rgb}`.)

- [ ] **Step 5: Commit**

```bash
git add src/host/render
git commit -m "feat: add render RGBA-to-protocol-Color mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `attributesToMask` — OpenTUI attributes → protocol 6-bit mask

**Files:**
- Create: `src/host/render/model/attributes.ts`
- Create: `src/host/render/model/attributes.test.ts`
- Modify: `src/host/render/index.ts`

**Interfaces:**
- Consumes: `TextAttributes`, `getBaseAttributes` from `@opentui/core`.
- Produces: `attributesToMask(raw: number): number` — the protocol attrs bitmask
  (1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough).

- [ ] **Step 1: Write the failing test**

`src/host/render/model/attributes.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"

import { attributesToMask } from "./attributes"

describe("attributesToMask", () => {
  test("maps none to 0", () => {
    expect(attributesToMask(0)).toBe(0)
  })

  test("keeps the coincident low bits (bold/dim/italic/underline)", () => {
    expect(attributesToMask(TextAttributes.BOLD)).toBe(1)
    expect(attributesToMask(TextAttributes.DIM)).toBe(2)
    expect(attributesToMask(TextAttributes.ITALIC)).toBe(4)
    expect(attributesToMask(TextAttributes.UNDERLINE)).toBe(8)
  })

  test("remaps INVERSE (OpenTUI 32) to protocol bit 16", () => {
    expect(attributesToMask(TextAttributes.INVERSE)).toBe(16)
  })

  test("remaps STRIKETHROUGH (OpenTUI 128) to protocol bit 32", () => {
    expect(attributesToMask(TextAttributes.STRIKETHROUGH)).toBe(32)
  })

  test("drops BLINK and HIDDEN (no protocol bit)", () => {
    expect(attributesToMask(TextAttributes.BLINK)).toBe(0)
    expect(attributesToMask(TextAttributes.HIDDEN)).toBe(0)
  })

  test("combines flags and strips a hyperlink id", () => {
    const raw = TextAttributes.BOLD | TextAttributes.INVERSE
    expect(attributesToMask(raw)).toBe(1 | 16)
    // A link id lives in the upper bits; getBaseAttributes must strip it.
    const withLink = raw | (7 << 8)
    expect(attributesToMask(withLink)).toBe(1 | 16)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/attributes.test.ts`
Expected: FAIL — cannot resolve `./attributes`.

- [ ] **Step 3: Write the implementation**

`src/host/render/model/attributes.ts`:

```ts
import { getBaseAttributes, TextAttributes } from "@opentui/core"

/**
 * Map OpenTUI's text-attribute integer to the protocol 6-bit mask (§5.3). NOT a
 * plain `& 0x3f`: OpenTUI `INVERSE=32` and `STRIKETHROUGH=128` do not sit on the
 * protocol's inverse (16) and strikethrough (32) bits, and `BLINK`/`HIDDEN` have
 * no protocol bit. `getBaseAttributes` first strips the hyperlink id from the
 * upper bits.
 */
export function attributesToMask(raw: number): number {
  const base = getBaseAttributes(raw)
  let mask = 0
  if (base & TextAttributes.BOLD) mask |= 1
  if (base & TextAttributes.DIM) mask |= 2
  if (base & TextAttributes.ITALIC) mask |= 4
  if (base & TextAttributes.UNDERLINE) mask |= 8
  if (base & TextAttributes.INVERSE) mask |= 16
  if (base & TextAttributes.STRIKETHROUGH) mask |= 32
  return mask
}
```

Append to `src/host/render/index.ts`:

```ts
export { attributesToMask } from "./model/attributes"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `getBaseAttributes`/`TextAttributes` are not exported
from the `@opentui/core` root, find their real export path with
`grep -r "getBaseAttributes" node_modules/@opentui/core/*.d.ts` and import from
there; the values are fixed as documented above.)

- [ ] **Step 5: Commit**

```bash
git add src/host/render
git commit -m "feat: add render attribute-to-protocol-mask remapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `styledRowsFromSpanLines` — captured spans → `StyledRun[][]`

**Files:**
- Create: `src/host/render/model/span-rows.ts`
- Create: `src/host/render/model/span-rows.test.ts`
- Modify: `src/host/render/index.ts`

**Interfaces:**
- Consumes: Task 1 `rgbaToColor`, Task 2 `attributesToMask`, `StyledRun` from
  `../../protocol`, `CapturedLine`/`RGBA` from `@opentui/core`.
- Produces: `styledRowsFromSpanLines(lines: CapturedLine[]): StyledRun[][]` — the
  pure mapping from OpenTUI capture rows to protocol styled rows.

- [ ] **Step 1: Write the failing test**

`src/host/render/model/span-rows.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes, type CapturedLine } from "@opentui/core"

import { styledRowsFromSpanLines } from "./span-rows"

const span = (text: string, fg: RGBA, bg: RGBA, attributes: number, width: number) => ({
  text,
  fg,
  bg,
  attributes,
  width,
})

describe("styledRowsFromSpanLines", () => {
  test("maps each span to a StyledRun with mapped color + attrs", () => {
    const lines: CapturedLine[] = [
      {
        spans: [
          span("ab", RGBA.defaultForeground(), RGBA.fromIndex(0), TextAttributes.BOLD, 2),
          span("c", RGBA.fromInts(255, 136, 0), RGBA.defaultBackground(), TextAttributes.INVERSE, 1),
        ],
      },
      { spans: [span("xyz", RGBA.defaultForeground(), RGBA.defaultBackground(), 0, 3)] },
    ]
    expect(styledRowsFromSpanLines(lines)).toEqual([
      [
        { text: "ab", fg: "default", bg: { indexed: 0 }, attrs: 1 },
        { text: "c", fg: { rgb: "#ff8800" }, bg: "default", attrs: 16 },
      ],
      [{ text: "xyz", fg: "default", bg: "default", attrs: 0 }],
    ])
  })

  test("maps an empty line to an empty row", () => {
    expect(styledRowsFromSpanLines([{ spans: [] }])).toEqual([[]])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/span-rows.test.ts`
Expected: FAIL — cannot resolve `./span-rows`.

- [ ] **Step 3: Write the implementation**

`src/host/render/model/span-rows.ts`:

```ts
import type { CapturedLine } from "@opentui/core"

import type { StyledRun } from "../../protocol"
import { attributesToMask } from "./attributes"
import { rgbaToColor } from "./color"

/**
 * Map OpenTUI capture rows to protocol styled rows. Runs are preserved 1:1 (the
 * protocol carries runs, not per-cell records); every span's display widths in a
 * row already tile to the frame width, so no per-cell expansion is needed here.
 */
export function styledRowsFromSpanLines(lines: CapturedLine[]): StyledRun[][] {
  return lines.map((line) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: rgbaToColor(span.fg),
      bg: rgbaToColor(span.bg),
      attrs: attributesToMask(span.attributes),
    })),
  )
}
```

Append to `src/host/render/index.ts`:

```ts
export { styledRowsFromSpanLines } from "./model/span-rows"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `CapturedLine` is not exported from the `@opentui/core`
root type surface, import it from the file that declares it — `grep -rl
"interface CapturedLine" node_modules/@opentui/core` — the shape is
`{ spans: CapturedSpan[] }`.)

- [ ] **Step 5: Commit**

```bash
git add src/host/render
git commit -m "feat: add captured-span-lines to styled-rows mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `makeHeadlessStreams` — the fake stdin/stdout shim

**Files:**
- Modify: `src/host/types.ts` (append `Size`)
- Create: `src/host/render/model/streams.ts`
- Create: `src/host/render/model/streams.test.ts`
- Modify: `src/host/render/index.ts`

**Interfaces:**
- Consumes: `Size` from `../../types`, `Writable`/`Readable` from `node:stream`.
- Produces: `makeHeadlessStreams(size: Size): { stdin, stdout }` — the fake TTY
  streams whose `columns`/`rows` equal `size` (they outrank the renderer config).

- [ ] **Step 1: Write the failing test**

`src/host/render/model/streams.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { makeHeadlessStreams } from "./streams"

describe("makeHeadlessStreams", () => {
  test("stdout reports the requested size and swallows writes", () => {
    const { stdout } = makeHeadlessStreams({ w: 100, h: 40 })
    expect(stdout.isTTY).toBe(true)
    expect(stdout.columns).toBe(100)
    expect(stdout.rows).toBe(40)
    expect(stdout.getColorDepth()).toBe(24)
    let called = false
    stdout.write(Buffer.from("x"), () => {
      called = true
    })
    expect(called).toBe(true)
  })

  test("stdin is a TTY with setRawMode", () => {
    const { stdin } = makeHeadlessStreams({ w: 10, h: 5 })
    expect(stdin.isTTY).toBe(true)
    expect(typeof stdin.setRawMode).toBe("function")
    expect(stdin.setRawMode(true)).toBe(stdin)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/streams.test.ts`
Expected: FAIL — cannot resolve `./streams`.

- [ ] **Step 3: Write the implementation**

Append to `src/host/types.ts`:

```ts
/** A terminal-cell size (columns × rows) shared across the host module. */
export interface Size {
  readonly w: number
  readonly h: number
}
```

`src/host/render/model/streams.ts`:

```ts
import { Readable, Writable } from "node:stream"

import type { Size } from "../../types"

/**
 * Fake TTY streams for a headless renderer. `columns`/`rows` are set to the
 * requested size because `createCliRenderer` sizes as `stdout.columns ||
 * config.width` — the stream value OUTRANKS the config (Spike B trap). `isTTY`
 * and `setRawMode` are load-bearing: `setupTerminal()` calls both.
 */
export function makeHeadlessStreams(size: Size) {
  const stdout = Object.assign(
    new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    {
      isTTY: true as const,
      columns: size.w,
      rows: size.h,
      getColorDepth: () => 24,
    },
  )
  const stdin: Readable & { isTTY: true; setRawMode: (raw: boolean) => unknown } =
    Object.assign(new Readable({ read() {} }), {
      isTTY: true as const,
      setRawMode(_raw: boolean) {
        return stdin
      },
    })
  return { stdin, stdout }
}
```

Append to `src/host/render/index.ts`:

```ts
export { makeHeadlessStreams } from "./model/streams"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host
git commit -m "feat: add headless fake-TTY stream shim with size-outranks-config note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `createHeadlessRenderer` + `renderNodeOnce` — the live harness

**Files:**
- Create: `src/host/render/model/renderer.ts`
- Create: `src/host/render/model/renderer.test.tsx`
- Modify: `src/host/render/index.ts`

**Interfaces:**
- Consumes: `createCliRenderer` from `@opentui/core`, `createRoot` from
  `@opentui/react`, Task 3 `styledRowsFromSpanLines`, Task 4 `makeHeadlessStreams`,
  `Size` from `../../types`, `RenderHandle`/`CapturedFrame` from `../types`.
- Produces: `createHeadlessRenderer(size: Size): Promise<RenderHandle>` and
  `renderNodeOnce(node: unknown, size: Size): Promise<CapturedFrame>`. 2C's host
  session mounts a page via `createHeadlessRenderer` (preview) or `renderNodeOnce`
  (smoke/export); it — not this library — owns any `process.exit`.

- [ ] **Step 1: Write the failing test**

`src/host/render/model/renderer.test.tsx`:

```tsx
import { afterEach, describe, expect, test } from "bun:test"

import type { RenderHandle } from "../types"
import { createHeadlessRenderer, renderNodeOnce } from "./renderer"

// Every live renderer MUST be destroyed so `bun test` can exit (Spike D).
let open: RenderHandle | null = null
afterEach(() => {
  open?.destroy()
  open = null
})

// Concatenate a row's run text back into a line string for content assertions.
const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("")

describe("headless renderer", () => {
  test("renders a static box+text tree and captures the frame", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 4 })
    open = handle
    handle.mount(
      <box>
        <text>hello</text>
      </box>,
    )
    await handle.render()
    const frame = handle.capture()

    expect(frame.width).toBe(20)
    expect(frame.height).toBe(4)
    expect(frame.rows).toHaveLength(4)
    // "hello" appears somewhere in the first row's runs.
    expect(lineText(frame, 0)).toContain("hello")
  })

  test("renderNodeOnce creates, renders, captures, and tears down", async () => {
    const frame = await renderNodeOnce(
      <box>
        <text>once</text>
      </box>,
      { w: 12, h: 2 },
    )
    expect(frame.height).toBe(2)
    expect(lineText(frame, 0)).toContain("once")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/renderer.test.tsx`
Expected: FAIL — cannot resolve `./renderer`.

- [ ] **Step 3: Write the implementation**

`src/host/render/model/renderer.ts`:

```ts
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

import type { Size } from "../../types"
import type { CapturedFrame, RenderHandle } from "../types"
import { styledRowsFromSpanLines } from "./span-rows"
import { makeHeadlessStreams } from "./streams"

/**
 * Create a headless OpenTUI renderer on the public API with fake TTY streams and
 * memory-buffered output. The returned handle mounts a React tree, paints, and
 * captures styled frames. The caller owns teardown (and, in a one-shot host
 * process, the `process.exit` that Spike D requires — never call it here).
 */
export async function createHeadlessRenderer(size: Size): Promise<RenderHandle> {
  const { stdin, stdout } = makeHeadlessStreams(size)
  const renderer: CliRenderer = await createCliRenderer({
    stdin: stdin as never,
    stdout: stdout as never,
    width: size.w,
    height: size.h,
    bufferedOutput: "memory",
    screenMode: "main-screen",
    consoleMode: "disabled",
    externalOutputMode: "passthrough",
    useMouse: false,
    exitOnCtrlC: false,
  })
  const root = createRoot(renderer)

  return {
    mount(node) {
      root.render(node as never)
    },
    async render() {
      renderer.intermediateRender()
      await renderer.idle()
    },
    capture(): CapturedFrame {
      const buffer = renderer.currentRenderBuffer
      return {
        width: buffer.width,
        height: buffer.height,
        rows: styledRowsFromSpanLines(buffer.getSpanLines()),
      }
    },
    destroy() {
      root.unmount()
      renderer.destroy()
    },
  }
}

/** One-shot render: create, mount, paint, capture, tear down. */
export async function renderNodeOnce(node: unknown, size: Size): Promise<CapturedFrame> {
  const handle = await createHeadlessRenderer(size)
  try {
    handle.mount(node)
    await handle.render()
    return handle.capture()
  } finally {
    handle.destroy()
  }
}
```

Append to `src/host/render/index.ts`:

```ts
export { createHeadlessRenderer, renderNodeOnce } from "./model/renderer"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render/model/renderer.test.tsx && bun x tsc --noEmit`
Expected: PASS, exit 0.

**Empirical notes for the implementer (adjust within the invariants, do not weaken
the spec):**
- The exact `createRoot`/`root.render` type may need a small `as never`/cast to
  accept a JSX node under the pinned types — the runtime call is what the probe
  proved. Confirm the real import: `createRoot` from `@opentui/react`
  (`grep -r "createRoot" node_modules/@opentui/react/*.d.ts`).
- `currentRenderBuffer` / `getSpanLines` / `idle` / `intermediateRender` /
  `destroy` are all public (`renderer.d.ts`); if a name differs in the installed
  types, find it there — do not switch to `@opentui/core/testing`.
- If the first captured frame is blank, you omitted `await renderer.idle()` after
  `intermediateRender()` — both are required.
- If `bun test` **hangs** after this test (native loop not releasing), see Task 6's
  hang check for the mitigation; do not paper over it with `process.exit` inside a
  test.

- [ ] **Step 5: Commit**

```bash
git add src/host/render
git commit -m "feat: add public-API headless renderer + one-shot render capture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: reatomComponent reactivity integration + full-suite hang check

**Files:**
- Create: `src/host/render/model/reactive.test.tsx`

**Interfaces:**
- Consumes: Task 5 harness, `atom` from `@reatom/core`, `reatomComponent` from
  `@reatom/react`.
- Produces: nothing new — proves a `reatomComponent` reading an atom re-renders on
  the production mount path with only a microtask tick (no `act()`), and that the
  whole suite leaves `bun test` able to exit.

- [ ] **Step 1: Write the test**

`src/host/render/model/reactive.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the reactive test**

Run: `bun test src/host/render/model/reactive.test.tsx`
Expected: PASS. (If `n=1` never appears: the production path should flush without
`act()`; ensure the `await tick()` is present between `counter.set(1)` and
`render()` — Reatom notify is deferred one microtask.)

- [ ] **Step 3: Full-suite + tsc + HANG CHECK**

Run: `bun test`
Expected: PASS — phase-0, runtime, all `host/protocol`, all `host/render` suites
green — **and the command returns to the shell within a few seconds.**

**If `bun test` hangs** (does not exit after printing results): the OpenTUI native
renderer is holding the event loop open. This is the Spike-D "process does not exit
on its own" trap surfacing in the test runner (where `process.exit` is not allowed).
Resolve it, in this order:
1. Confirm every test destroys its renderer (the `afterEach` above / `renderNodeOnce`'s
   `finally`). A leaked renderer is the most common cause.
2. If it still hangs, add a root `afterAll` (or a `--preload` teardown) that flushes
   OpenTUI's native workers — check `renderer.d.ts` / `@opentui/core` for a global
   shutdown (`destroy` should suffice; look for a module-level worker pool).
3. If a residual native handle cannot be released inside `bun test`, isolate the
   live-render integration tests (Tasks 5–6) behind their own `bun test
   src/host/render/model/renderer.test.tsx src/host/render/model/reactive.test.tsx
   --timeout 20000` invocation and document that the pure suites
   (`bun test`) stay hang-free — record the split in the report and the handoff, do
   NOT hide it.

Run: `bun x tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/host/render
git commit -m "test: add reatomComponent reactivity integration on the production mount path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (run before implementing)

- **Spec/recipe coverage:** RGBA→Color (default/transparent/indexed/rgb) → Task 1;
  attrs remap incl. INVERSE/STRIKETHROUGH shift + link strip → Task 2; span-rows
  run-preserving map → Task 3; fake-stream size-outranks-config + setRawMode → Task 4;
  public-API headless render + capture + one-shot teardown → Task 5; production-path
  reactivity without `act()` + the bun-test hang check → Task 6.
- **Type reuse:** `StyledRun`/`Color` come from `../../protocol` (2A), never
  redefined; `Size` is host-shared in `host/types.ts`.
- **Public API only in product code:** no `@opentui/core/testing` or
  `@opentui/react/test-utils` import under `model/`.
- **Teardown discipline:** every live renderer is destroyed (`afterEach` /
  `finally`); no `process.exit` in any test.
- **Empirical honesty:** integration tests assert invariants (text present, dims,
  row count), not brittle exact frames; any unresolved hang mitigation (test split)
  is recorded, not hidden.
```

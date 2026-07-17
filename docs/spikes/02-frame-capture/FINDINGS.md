# Spike B — styled cell-frame capture from the headless renderer

## The question

Can OpenTUI render headlessly at a fixed size with no TTY, from inside a
`bun build --compile` binary on Windows, and yield **per-cell** char + fg + bg +
attributes as §4.2's host protocol requires?

Headless rendering was already known to work, so the question was never "is it
possible". It was two separate questions, deliberately probed one at a time:

1. Which capture path carries per-cell style?
2. Does any of it survive `bun build --compile` on Windows with a native Zig core?

## Verdict

Verdict: YES

A full 80×24 **styled** grid can be reconstructed **losslessly** from
`captureSpans()`, and the whole path survives `bun build --compile` on Windows —
verified from a single-file `.exe` running in a directory containing no
`node_modules` and no `opentui.dll`.

**What the verdict rests on — all four directly observed, none inferred:**

1. **Style** — every one of the 1920 cells of an 80×24 styled frame had its fg, bg
   and attributes compared against `currentRenderBuffer.buffers`, the renderer's own
   raw per-cell arrays: **0 mismatches**.
2. **Attributes** — all 8 round-trip exactly, printed sent-vs-got, including a
   combined bitmask.
3. **Chars + geometry** — expanded spans reproduce `captureCharFrame()` byte-for-byte;
   every row's spans tile to exactly `cols`.
4. **`--compile`** — `isCompiledBinary: true`, `embeddedFiles: 14`, identical results
   from an isolated `.exe` (verbatim listing under *Step 4*).

The `/testing` stability question is a **Step 6 concern, not a verdict input**: the
verdict question is lossless reconstruction plus `--compile` on Windows, and `YES`
stands on the four observations above regardless of how the `/testing` exposure is
resolved. This matters, because the mitigation is weaker than a first reading
suggests (see Step 6).

Two caveats that are real but do not change the verdict, stated up front:

- `captureSpans()` returns **runs, not cells**. Reconstruction to per-cell is a
  mechanical run-expansion, not a direct read, and it requires a wcwidth algorithm
  the host must own. See *Shape* and *Lossless* below.
- The capability ships under `@opentui/core/testing` at **0.4.5** — a real
  architectural exposure. See *Step 6*.

## Environment

| Fact | Value |
| --- | --- |
| Platform | Windows 11 Pro 10.0.26200, win32 x64 |
| Bun | 1.3.14 |
| `@opentui/core` | **0.4.5** (resolved from `bun.lock`, verbatim below) |
| Native core | `@opentui/core-win32-x64@0.4.5` → `opentui.dll`, 3.61 MB |

Resolved version, verbatim from `docs/spikes/02-frame-capture/bun.lock`:

```
"@opentui/core": ["@opentui/core@0.4.5", "", { "dependencies": { "bun-ffi-structs": "0.2.4", "diff": "9.0.0", "marked": "17.0.1", "string-width": "7.2.0", "strip-ansi": "7.1.2" }, "optionalDependencies": { "@opentui/core-darwin-arm64": "0.4.5", "@opentui/core-darwin-x64": "0.4.5", "@opentui/core-linux-arm64": "0.4.5", "@opentui/core-linux-arm64-musl": "0.4.5", "@opentui/core-linux-x64": "0.4.5", "@opentui/core-linux-x64-musl": "0.4.5", "@opentui/core-win32-arm64": "0.4.5", "@opentui/core-win32-x64": "0.4.5" }, "peerDependencies": { "web-tree-sitter": "0.25.10" } }, "sha512-JsgRTPkA6e+Vxmumxai6SElOSlRQkbzNKHlCfemlArRiLhfC1IZ9RXJo2QH4xSu+uBOWAM90uss73/pPlkdEig=="],
```

## Shape

Shape: `captureSpans(): CapturedFrame` — run-length spans per line, not per-cell
records. Full literal declarations below.

The literal type `captureSpans()` returns, from
`node_modules/@opentui/core/testing/test-renderer.d.ts` and
`node_modules/@opentui/core/types.d.ts`. Copied verbatim, not paraphrased:

```ts
// testing/test-renderer.d.ts:51
captureSpans: () => CapturedFrame;

// types.d.ts:160-175
export interface CapturedSpan {
    text: string;
    fg: RGBA;
    bg: RGBA;
    attributes: number;
    width: number;
}
export interface CapturedLine {
    spans: CapturedSpan[];
}
export interface CapturedFrame {
    cols: number;
    rows: number;
    cursor: [number, number];
    lines: CapturedLine[];
}
```

`RGBA` is a **class**, not a plain triple (`lib/RGBA.d.ts`). The load-bearing members:

```ts
export type ColorIntent = "rgb" | "indexed" | "default";
export declare class RGBA {
    buffer: Uint16Array;          // [r, g, b, a], 0-255 ints
    toInts(): [number, number, number, number];
    get intent(): ColorIntent;    // survives round-trip
    get slot(): number;           // palette index when intent === "indexed"
}
```

This matters for serialization: `JSON.stringify(captureSpans())` does **not**
produce colour triples. It emits `{"fg":{"buffer":{"0":255,"1":0,"2":0,"3":255}}}`.
A host protocol must call `.toInts()` (or read `.buffer`) explicitly. Evidence is
in the raw-JSON block below.

### Answers to Step 3's precise questions

| Question | Answer |
| --- | --- |
| Per-cell records, or runs per line? | **Runs.** One `CapturedSpan` per maximal run of identically-styled text. |
| fg/bg RGB, palette indices, or strings? | Neither triples nor strings: **`RGBA` class instances**. Carry 0-255 RGBA ints *and* `intent` (`rgb`/`indexed`/`default`) + `slot`, so a palette index survives as an index rather than being flattened to RGB. |
| Which attributes survive? | **All eight**, exactly, including combined bitmasks: BOLD 1, DIM 2, ITALIC 4, UNDERLINE 8, BLINK 16, INVERSE 32, HIDDEN 64, STRIKETHROUGH 128. |
| Lossless 80×24 styled grid? | **Yes** — chars, geometry **and style** each measured against an independent oracle. See below. |

### Lossless: how it was measured, and the one catch

Spans are a run-length encoding of a styled grid. The probe did not take that on
faith. It expanded the runs into 1920 per-cell records and checked **four** things
on an 80×24 frame mixing fg, bg, bold, italic and wide CJK text:

| # | Check | Measures | Result |
| --- | --- | --- | --- |
| 1 | every row's spans sum to exactly `cols` | geometry | `true` |
| 2 | expansion yields exactly 24 rows × 80 cells | geometry | `true` |
| 3 | `reconstructed chars === captureCharFrame()` | **chars only** | `true` |
| 4 | every cell's fg/bg/attributes vs `currentRenderBuffer.buffers` | **style** | `0 / 1920 mismatches` |

Check 4 is the one that makes this a *styled*-grid answer. Checks 1-3 are
char/structural: `captureCharFrame()` is a **chars-only** capture, so no fg, bg or
attribute value is tested by it at all, and check 3 joins cells into one string,
discarding column identity. Check 4 supplies the missing half by comparing the
expanded span style of all 1920 cells against the renderer's own raw per-cell
arrays — an oracle **independent of the spans**:

```
per-cell style vs buffers oracle: 1920 cells checked, 0 mismatches -> true
LOSSLESS = true
  (allTile=true dimsOk=true charsIdentical=true styleMatchesOracle=true)
```

An earlier revision of this document asserted "proven by reconstruction" on the
strength of checks 1-3 alone, and inferred the styled half from span-level
round-trips collected in separate, smaller renderers. That was a real gap: the
verdict question is about the *styled* grid, and style was the one thing not
measured. Check 4 was added in response and closes it. The verdict did not change.

**The catch — wide characters.** `span.width` is display width, not codepoint
count. `"日本語ab"` is 5 codepoints but `width: 8`. So run-expansion is only
mechanical if the consumer re-derives each character's display width; a naive
`[...text]` walk would misalign every column after the first CJK glyph. The probe
used `Bun.stringWidth()` per character and cross-checked the derived total against
`span.width` on every span; no mismatch was ever reported. So expansion is
reliable, but it is **an algorithm the host must own**, and it must agree with the
renderer's configured `widthMethod` (`"wcwidth" | "unicode"`). This is the single
place §4.2's protocol can silently corrupt a frame.

### The other per-cell path: `buffers` — and why it is *not* a drop-in replacement

`captureSpans()` is not the only style-carrying path. `OptimizedBuffer` exposes raw
**per-cell** typed arrays (`buffer.d.ts:22-27`), public and not `/testing`-scoped:

```ts
get buffers(): {
    char: Uint32Array;        // 1 per cell
    fg: Uint16Array;          // 4 per cell (RGBA)
    bg: Uint16Array;          // 4 per cell (RGBA)
    attributes: Uint32Array;  // 1 per cell
};
```

Lengths at 80×24 are `char: 1920, fg: 7680, bg: 7680, attributes: 1920` — but
lengths are arithmetic from the allocation, not observation. The **values** were
read, and the encoding is only partly what the shape suggests:

**fg/bg — usable, and richer than RGB.** Each cell's 4 `Uint16` slots are the *same
packed encoding as `RGBA.buffer`*, **not** plain 0-255 components. For an RGB colour
the slots do hold 0-255, but for an indexed colour they do not — `RGBA.fromIndex(9)`
stores `[2559, 256, 0, 255]` (2559 = 0x9FF > 255). The metadata rides in the high
bits, and `RGBA.fromArray()` decodes the slice correctly:

```
span fg  -> {"intent":"indexed","slot":9,"ints":[255,0,0,255]}  .buffer raw = [2559,256,0,255]
raw buffers fg cell0 = [2559,256,0,255]
RGBA.fromArray(raw slice) -> {"intent":"indexed","slot":9,"ints":[255,0,0,255]}
```

So `intent`/`slot` **are** representable in the flat array and survive — but only if
consumers decode via `RGBA.fromArray()` rather than reading the integers directly.
Reading them raw would yield `2559` for a red channel.

**attributes — usable.** Plain bitmask, matches the span value exactly.

**`char` — NOT plain codepoints, and this is a trap.** ASCII cells hold the
codepoint (`65` = `"A"`, `98` = `"b"`, `32` = `" "`). Wide characters do not.
Rendering `"A日b"` (日 = U+65E5, display width 2):

```
  cell[0][0] char=        65 0x00000041 "A" fg=[255,0,0,255] attr=1
  cell[0][1] char=2416050429 0x900200fd <NOT A CODEPOINT: Arguments contain a value that is out of range of code points> fg=[255,0,0,255] attr=1
  cell[0][2] char=3288465661 0xc40200fd <NOT A CODEPOINT: Arguments contain a value that is out of range of code points> fg=[255,0,0,255] attr=1
  cell[0][3] char=        98 0x00000062 "b" fg=[255,0,0,255] attr=1
  cell[0][4] char=        32 0x00000020 " " fg=[255,255,255,255] attr=0
```

Neither `0x900200fd` (the 日 cell) nor `0xc40200fd` (its trailing column) is U+65E5,
and `String.fromCodePoint()` throws `RangeError` on both. The values are a tagged /
packed encoding that is **undocumented in the `.d.ts`** and was not reverse-engineered
here. Note the style columns are still correct on those cells — only `char` is opaque.

**Consequence for §4.2.** `buffers` is a good source for **fg/bg/attributes** (direct,
per-cell, no wcwidth step, decode via `RGBA.fromArray`). It is **not** a safe source
for **text**: its `char` encoding is unspecified and breaks on the first CJK glyph.
`captureSpans()` / `getSpanLines()` remain the trustworthy text path. An earlier
revision of this document recommended preferring `buffers` over `captureSpans()`
outright, on the strength of array lengths alone; that recommendation is **withdrawn**
— see *Recommendation for Task 4* in Step 6 for the corrected form.

## Evidence

### Step 2 — baseline under `bun run` (verbatim)

Established before compiling, so a failure would be attributable to one variable.
`Text({ content })` from the plan **is** the real 0.4.5 signature and worked as
written.

```
=== RUNTIME ===
bun version: 1.3.14
execPath: C:\Users\Khmil\.bun\bin\bun.exe
isCompiledBinary: false
embeddedFiles: 0
platform: win32 x64
stdout.isTTY: false

=== STEP 2: BASELINE (40x10) ===
--- captureCharFrame ---
Hello                                   
                                        
                                        
                                        
                                        
                                        
                                        
                                        
                                        
                                        

--- testing exports ---
KeyCodes, ManualClock, MockTreeSitterClient, MouseButtons, TestRecorder, createMockKeys, createMockMouse, createSpy, createTerminalCapabilities, createTestRenderer, pasteBytes, setRendererCapabilities
```

That is the complete, untrimmed 40×10 block: `"Hello"` then 35 spaces, followed by
nine rows of 40 spaces — `captureCharFrame()` space-pads to the full grid and ends
each row with `\n`. `stdout.isTTY: false` confirms no physical terminal.

The 12 names above are the module's **actual exports**. `renderOnce`, `captureSpans`,
`captureCharFrame`, `resize`, `mockInput`, `mockMouse` are *not* among them — they are
fields of the object `createTestRenderer()` returns (`TestRendererSetup`). See
*Discrepancies* #2.

### Step 3 — what carries style (verbatim)

```
--- captureSpans() raw JSON (fg/bg are RGBA class instances) ---
{
  "cols": 20,
  "rows": 3,
  "cursor": [
    1,
    1
  ],
  "lines": [
    {
      "spans": [
        {
          "text": "AB",
          "fg": {
            "buffer": {
              "0": 255,
              "1": 0,
              "2": 0,
              "3": 255
            }
          },
          "bg": {
            "buffer": {
              "0": 0,
              "1": 0,
              "2": 255,
              "3": 255
            }
          },
          "attributes": 1,
          "width": 2
        },
--- decoded line 0 ---
{"text":"AB","width":2,"attributes":1,"fg":[255,0,0,255],"fgIntent":"rgb","bg":[0,0,255,255],"bgIntent":"rgb"}
{"text":"                  ","width":18,"attributes":0,"fg":[255,255,255,255],"fgIntent":"rgb","bg":[0,0,0,0],"bgIntent":"rgb"}

--- attribute round-trip ---
TextAttributes = {"NONE":0,"BOLD":1,"DIM":2,"ITALIC":4,"UNDERLINE":8,"BLINK":16,"INVERSE":32,"HIDDEN":64,"STRIKETHROUGH":128}
BOLD           sent=  1 got=  1 match=true
DIM            sent=  2 got=  2 match=true
ITALIC         sent=  4 got=  4 match=true
UNDERLINE      sent=  8 got=  8 match=true
BLINK          sent= 16 got= 16 match=true
INVERSE        sent= 32 got= 32 match=true
HIDDEN         sent= 64 got= 64 match=true
STRIKETHROUGH  sent=128 got=128 match=true
COMBINED(B|I|U) sent=13 got=13 match=true

--- color representation ---
RGBA.fromIndex(9) -> {"intent":"indexed","slot":9,"ints":[255,0,0,255]}
blank cell -> {"fgIntent":"rgb","fg":[255,255,255,255],"bgIntent":"rgb","bg":[0,0,0,0]}
```

Note `blank cell` background is `[0,0,0,0]` — alpha 0, i.e. transparent rather
than opaque black. An exporter that ignores alpha will paint unset cells black.

### The verdict probe — lossless 80×24 (verbatim)

The `||` in each sample row separates the expanded-span style (left) from the
independent `buffers` oracle (right). `styleMatchesOracle` is the check that makes
this a *styled*-grid result rather than a chars-only one.

```
=== VERDICT PROBE: lossless 80x24 reconstruction ===
cols = 80  rows = 24  lines = 24
cursor = [1,1]
all rows tile to cols: true  widths: [80]
grid is 24x80: true  row lengths: [80]
reconstructed chars === captureCharFrame(): true
per-cell style vs buffers oracle: 1920 cells checked, 0 mismatches -> true
LOSSLESS = true
  (allTile=true dimsOk=true charsIdentical=true styleMatchesOracle=true)
--- sample styled cells from row 0: expanded span vs raw buffers ---
  cell[0][ 0] = "R" fg=[255,0,0,255] bg=[0,0,0,0] attr=0 || raw fg=[255,0,0,255] bg=[0,0,0,0] attr=0
  cell[0][ 3] = "G" fg=[255,255,255,255] bg=[0,255,0,255] attr=0 || raw fg=[255,255,255,255] bg=[0,255,0,255] attr=0
  cell[0][ 6] = "B" fg=[255,255,255,255] bg=[0,0,0,0] attr=1 || raw fg=[255,255,255,255] bg=[0,0,0,0] attr=1
  cell[0][10] = "I" fg=[255,255,255,255] bg=[0,0,0,0] attr=4 || raw fg=[255,255,255,255] bg=[0,0,0,0] attr=4
  cell[0][14] = "p" fg=[255,255,255,255] bg=[0,0,0,0] attr=0 || raw fg=[255,255,255,255] bg=[0,0,0,0] attr=0
  cell[0][20] = "日" fg=[255,255,255,255] bg=[0,0,0,0] attr=0 || raw fg=[255,255,255,255] bg=[0,0,0,0] attr=0
```

The `.buffers` encoding evidence, same run:

```
=== .buffers ENCODING: actual values, not lengths ===
array types: {"char":"Uint32Array","fg":"Uint16Array","bg":"Uint16Array","attributes":"Uint32Array"}
span0: {"text":"A日b","fg":[255,0,0,255],"bg":[0,0,255,255],"attr":1}
rendering "A日b" (日 is U+65E5, display width 2):
  cell[0][0] char=        65 0x00000041 "A" fg=[255,0,0,255] attr=1
  cell[0][1] char=2416050429 0x900200fd <NOT A CODEPOINT: Arguments contain a value that is out of range of code points> fg=[255,0,0,255] attr=1
  cell[0][2] char=3288465661 0xc40200fd <NOT A CODEPOINT: Arguments contain a value that is out of range of code points> fg=[255,0,0,255] attr=1
  cell[0][3] char=        98 0x00000062 "b" fg=[255,0,0,255] attr=1
  cell[0][4] char=        32 0x00000020 " " fg=[255,255,255,255] attr=0
indexed colour RGBA.fromIndex(9):
  span fg  -> {"intent":"indexed","slot":9,"ints":[255,0,0,255]}  .buffer raw = [2559,256,0,255]
  raw buffers fg cell0 = [2559,256,0,255]
  RGBA.fromArray(raw slice) -> {"intent":"indexed","slot":9,"ints":[255,0,0,255]}
```

### Step 4 — `bun build --compile` on Windows (verbatim)

This was the highest-risk step and the one the spec never mentions. **The native
Zig core loads from the single-file executable.**

```
$ bun build --compile src/main.ts --outfile probe.exe
  [44ms]  bundle  20 modules
 [496ms] compile  probe.exe
```

Produces `probe.exe` (107,481,600 bytes ≈ 102.5 MB). It was copied **alone** into an
empty directory and run there. The isolation is recorded, not asserted:

```
=== VERBATIM ISOLATION EVIDENCE ===
--- Get-ChildItem -Force (full listing) ---

Mode     Length Name
----     ------ ----
-a--- 107481600 probe.exe


--- DLL/node count reachable (recursive) ---
*.dll : 0
*.node: 0
node_modules present: False
```

Running `.\probe.exe` from that directory:

```
=== RUNTIME ===
bun version: 1.3.14
execPath: ...\scratchpad\isolated\probe.exe
isCompiledBinary: true
embeddedFiles: 14
platform: win32 x64
stdout.isTTY: false
```

...followed by every section producing results **identical** to `bun run`,
including the style oracle and the `/testing`-free public path:

```
=== VERDICT PROBE: lossless 80x24 reconstruction ===
per-cell style vs buffers oracle: 1920 cells checked, 0 mismatches -> true
LOSSLESS = true
  (allTile=true dimsOk=true charsIdentical=true styleMatchesOracle=true)
  cell[0][1] char=2416050429 0x900200fd <NOT A CODEPOINT: ...> fg=[255,0,0,255] attr=1
  intermediateRender()          PUBLIC  renderer.d.ts:560 painted=true  span0="PUB" attr=1
  requestRender() only          PUBLIC  renderer.d.ts:388 painted=false span0="਀਀਀਀..." attr=0
  requestRender() + await tick  PUBLIC  renderer.d.ts:388 painted=true  span0="PUB" attr=1
  start() + tick + stop()       PUBLIC  renderer.d.ts:545/552 painted=true  span0="PUB" attr=1
  loop()                        PRIVATE renderer.d.ts:559 painted=true  span0="PUB" attr=1
STEP6_TESTING_FREE_PATH_WORKS_PUBLIC_ONLY = true
=== PROBE COMPLETE ===
```

Exit code 0. A full `Compare-Object` diff of `bun run` output vs compiled-isolated
output differed **only** in: `execPath`, `isCompiledBinary`, `embeddedFiles`,
timing numbers, and the *order* (not the set) of `Object.keys()` on the `/testing`
module. Every substantive finding was byte-identical.

**Why it works.** `@opentui/core-win32-x64` ships a Bun-specific entry that uses
Bun's asset-embedding mechanism — the exact route the plan asked about:

```js
// node_modules/@opentui/core-win32-x64/index.bun.js
const module = await import("./opentui.dll", { with: { type: "file" } })
export default module.default
```

`bun build --compile` embeds `opentui.dll` as one of the 14 embedded files and
Bun's FFI loads it from the compiled binary. It does **not** look for a
`.dll`/`.node` beside the executable. The package also ships `lib/bunfs.d.ts`
(`isBunfsPath`, `getBunfsRootPath`, `normalizeBunfsPath`) and
`resolveBundledFilePath`, i.e. `--compile` is a supported scenario upstream, not an
accident. No `with { type: "file" }` work was needed on our side.

This is a **positive** result on the plan's Known Risk #2. §4.1's single-binary
packaging story holds for the frame-capture path on Windows.

### Step 5 — resize, mouse, timing (verbatim, compiled binary)

```
=== STEP 5: RESIZE / MOUSE / TIMING ===
before: cols=80 rows=24 lines=24 charFrameLines=24
after resize(120,40): cols=120 rows=40 lines=40 charFrameLines=40 firstLineWidth=120
resize tracked: true
mockMouse.click(3,0) -> handlers fired: ["mousedown","mouseup"]
mouse position: {"x":3,"y":0}
hit resolved: true
--- timing: createTestRenderer + renderOnce + capture @ 80x24 ---
run0: total=2.98ms (create=1.31 render=0.60 capture=1.07)
run1: total=2.20ms (create=0.76 render=0.38 capture=1.06)
run2: total=2.12ms (create=0.81 render=0.31 capture=1.00)
run3: total=2.03ms (create=0.72 render=0.31 capture=1.00)
run4: total=2.24ms (create=0.72 render=0.37 capture=1.15)
min=2.03ms median=2.20ms max=2.98ms
```

- **Resize tracking (§4.2 forwards resize):** works. After `resize(120, 40)` both
  capture paths track it — `captureSpans()` reports `cols=120 rows=40` with 40
  lines that still tile to 120, and `captureCharFrame()` returns 40 lines of 120
  columns. No renderer re-creation needed.
- **`mockMouse` hit resolution (§3.5 defers interactive mode to v1.0):** works.
  `mockMouse.click(3, 0)` resolved to the renderable under the cursor and fired
  `onMouseDown` + `onMouseUp`. Banked as a cheap fact; not part of this verdict.
- **Wall clock, `createTestRenderer` + `renderOnce` + capture @ 80×24:** every
  recorded run is tabulated below. **No ordering between `bun run` and compiled is
  claimed** — the numbers move with machine load, and across four recorded runs
  neither is consistently faster:

  | Run | Mode | min | median | max |
  | --- | --- | --- | --- | --- |
  | 1 (idle machine) | `bun run` | 1.80 | 2.28 | 3.31 |
  | 2 (idle machine) | compiled | 2.03 | 2.20 | 2.98 |
  | 3 (loaded: 2 sibling spikes building) | `bun run` | 3.87 | 4.10 | 6.01 |
  | 4 (loaded: 2 sibling spikes building) | compiled | 7.14 | 8.28 | 15.40 |

  Runs 1-2 are near-identical; runs 3-4 show `bun run` *ahead* of compiled, the
  reverse of runs 1-2. That spread is load, not a property of `--compile`. An
  earlier revision of this document claimed "compiled is consistently faster" and
  cited a median of `4.07 ms` that appears in **no recorded output**; both are
  withdrawn. Verbatim blocks for runs 3-4 are in the *Timing (verbatim)* section
  below.

  **Export is seconds, not minutes** (§3.7 renders a fresh host per page per size).
  Taking the **worst** observed figure (15.40 ms), 100 pages × 5 sizes = 500 renders
  ≈ **7.7 s**; at the best (1.80 ms) ≈ **0.9 s**. The decision is unaffected by the
  spread. This is
  not a bottleneck and needs no host-reuse optimization.

### Timing (verbatim, runs 3-4 — loaded machine, same probe build)

`bun run`:

```
--- timing: createTestRenderer + renderOnce + capture @ 80x24 ---
run0: total=5.17ms (create=1.79 render=0.83 capture=2.56)
run1: total=3.87ms (create=1.61 render=0.79 capture=1.48)
run2: total=4.10ms (create=1.09 render=0.53 capture=2.49)
run3: total=6.01ms (create=1.85 render=0.96 capture=3.20)
run4: total=3.93ms (create=1.66 render=0.85 capture=1.43)
min=3.87ms median=4.10ms max=6.01ms
```

compiled (isolated `probe.exe`):

```
--- timing: createTestRenderer + renderOnce + capture @ 80x24 ---
run0: total=8.28ms (create=3.23 render=1.19 capture=3.85)
run1: total=15.40ms (create=2.26 render=7.47 capture=5.68)
run2: total=7.14ms (create=2.62 render=1.32 capture=3.20)
run3: total=9.56ms (create=4.88 render=1.07 capture=3.60)
run4: total=7.65ms (create=2.09 render=1.72 capture=3.84)
min=7.14ms median=8.28ms max=15.40ms
```

## Step 6 — judgment: `@opentui/core/testing` as production infrastructure

Stated plainly, not softened.

**The exposure is real.** The spec's design host needs headless styled capture in
**production**. OpenTUI ships `createTestRenderer` / `captureSpans` /
`captureCharFrame` / `mockMouse` under the `@opentui/core/testing` subpath at
version **0.4.5**. Two independent problems compound:

1. **Testing-scoped APIs carry no stability guarantee.** A `/testing` subpath
   signals "for your test suite" — maintainers routinely reshape such APIs without
   treating it as a breaking change, because the implied contract is that only
   tests depend on them. Shipping a product feature on it means our production path
   is not covered by whatever compatibility promise the package makes.
2. **0.4.5 is pre-1.0.** Under semver, minor bumps may break. `0.x` packages break
   minor-to-minor in practice, and OpenTUI is young and moving.

Together: the design host and export would rest on the least-guaranteed surface of
a fast-moving pre-1.0 dependency. That is a genuine architectural exposure and
Task 4 must weigh it, not wave at it.

**A non-testing headless path does exist — but the first version of this section
overstated it, and the correction matters.** `createTestRenderer` is a thin harness.
Read from the installed package:

```js
// testing.bun.js — setupTestRenderer
const stdin = config.stdin || createTestStdin();
const stdout = config.stdout || createTestStdout(width, height);
return new CliRenderer(stdin, stdout, width, height, {
  ...config,
  bufferedOutput: config.bufferedOutput ?? "memory"
});

// testing.bun.js:600-606 — renderOnce   <-- the function that drives the frame
const renderOnce = async () => {
  const feed = renderer._feed;              // PRIVATE (renderer.d.ts:331)
  if (feed?.isBackpressured()) {
    await feed.idle();
  }
  await renderer.loop();                    // PRIVATE (renderer.d.ts:559)
};

// testing.bun.js:696 — captureSpans
captureSpans: () => {
  const currentBuffer = renderer.currentRenderBuffer;
  const lines = currentBuffer.getSpanLines();
  const cursorState = renderer.getCursorState();
  return { cols: currentBuffer.width, rows: currentBuffer.height,
           cursor: [cursorState.x, cursorState.y], lines };
}
```

**The correction.** An earlier revision of this document claimed "every member it
touches is on the public surface" and rebuilt the path with `await renderer.loop()`.
That was **false**: `loop` is declared `private loop;` at `renderer.d.ts:559`
(between `private startRenderLoop` :558 and `private renderNative` :561), and
`_feed` is `private _feed;` at `:331`. The rebuild only ran because neither
`bun run` nor `--compile` typechecks — `tsc` would reject it as TS2341 under this
spike's own strict tsconfig. The earlier table also omitted `renderOnce` entirely,
which is precisely what made "every member is public" look true.

Had it stood, the recommendation would have inverted its own logic: it would swap a
*declared, typed, intentionally-exported* testing subpath for an **undeclared private
member** with no typings and no stability guarantee whatsoever — a worse exposure,
not a better one.

**The re-probe: a genuinely public render route exists.** Every render entry point on
`CliRenderer` was enumerated and driven against a real frame. Verbatim:

```
--- render route survey (does it paint a styled frame?) ---
  intermediateRender()          PUBLIC  renderer.d.ts:560 painted=true  span0="PUB" attr=1
  requestRender() only          PUBLIC  renderer.d.ts:388 painted=false span0="਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀਀" attr=0
  requestRender() + await tick  PUBLIC  renderer.d.ts:388 painted=true  span0="PUB" attr=1
  start() + tick + stop()       PUBLIC  renderer.d.ts:545/552 painted=true  span0="PUB" attr=1
  loop()                        PRIVATE renderer.d.ts:559 painted=true  span0="PUB" attr=1
```

**`intermediateRender()` (`renderer.d.ts:560`) is public, synchronous, and paints a
correctly styled frame** — it is the honest replacement for private `loop()`. Note
`requestRender()` alone does **not** paint (it only schedules; the buffer still holds
unrendered `਀` fill), so it needs an awaited tick; `start()/stop()` works but
runs the real loop.

With `intermediateRender()`, every member is genuinely public:

| Member | Declared |
| --- | --- |
| `CliRenderer` ctor `(stdin, stdout, w, h, config)` | `renderer.d.ts:362` — public |
| `createCliRenderer(config)` | `renderer.d.ts:177` — public |
| `bufferedOutput: "stdout" \| "memory"` | `renderer.d.ts:21`, `zig.d.ts:75` — public |
| **`intermediateRender()`** | **`renderer.d.ts:560` — public** |
| `renderer.currentRenderBuffer` | `renderer.d.ts:217` — public |
| `renderer.getCursorState()` | `renderer.d.ts:536` — public |
| `OptimizedBuffer.getSpanLines()` | `buffer.d.ts:43` — public |
| `OptimizedBuffer.getRealCharBytes()` | `buffer.d.ts:42` — public |
| `OptimizedBuffer.buffers` | `buffer.d.ts:22-27` — public |
| `CapturedFrame` / `CapturedLine` / `CapturedSpan` | `types.d.ts` — main index, **not** `/testing` |
| ~~`renderer.loop()`~~ | `renderer.d.ts:559` — **private, no longer used** |
| ~~`renderer._feed`~~ | `renderer.d.ts:331` — **private, see caveat** |

Rebuild driven by `intermediateRender()` only, verbatim:

```
--- full rebuild via PUBLIC intermediateRender() ---
createCliRenderer/CliRenderer headless: OK
public getSpanLines() span[0] = {"text":"PUBLIC","width":6,"attributes":1,"fg":[255,0,0,255],"bg":[0,0,255,255]}
frame cols=80 rows=24 lines=24 tiles=true
buf.buffers lengths: {"char":1920,"fg":7680,"bg":7680,"attributes":1920,"expectedCells":1920}
buf.buffers VALUES cell[0][0..5]: [{"char":80,"fg":[255,0,0,255],"attr":1},{"char":85,"fg":[255,0,0,255],"attr":1},{"char":66,"fg":[255,0,0,255],"attr":1},{"char":76,"fg":[255,0,0,255],"attr":1},{"char":73,"fg":[255,0,0,255],"attr":1},{"char":67,"fg":[255,0,0,255],"attr":1}]
STEP6_TESTING_FREE_PATH_WORKS_PUBLIC_ONLY = true
```

(`char` 80,85,66,76,73,67 = `P,U,B,L,I,C` — ASCII codepoints, consistent with the
encoding findings above.)

**Two caveats on the rebuild, so Task 4 sizes it honestly:**

1. **Backpressure handling is dropped.** The harness's `renderOnce` checks
   `_feed.isBackpressured()` and awaits `_feed.idle()` before rendering. `_feed` is
   private, so a public rebuild cannot do this. With `bufferedOutput: "memory"` and a
   discarding stdout it did not bite in any run here, but it is unproven under load
   and is a real behavioural difference, not a cosmetic one.
2. **The fake stdout's `isTTY = true` is load-bearing.** `CliRenderer` branches on it;
   the streams must present as a TTY (`columns`, `rows`, `getColorDepth()`) even
   though nothing is displayed.

So "~30 lines to own" (the earlier estimate) understates it: it is a small amount of
code plus an unowned backpressure question. Still modest — but not free.

Notably, `CapturedFrame` — the very type `captureSpans()` returns — lives in the
main `types.d.ts`, and `getSpanLines()` is public on `OptimizedBuffer`. The
*capture* capability is public; only the *harness* is testing-scoped.

**Recommendation for Task 4.** Two options, both viable; the choice is Task 4's and
neither is free:

- **Option A — public rebuild.** `CliRenderer` + `bufferedOutput: "memory"` +
  **`intermediateRender()`** + `currentRenderBuffer.getSpanLines()`. Entirely public,
  demonstrated working here (`STEP6_TESTING_FREE_PATH_WORKS_PUBLIC_ONLY = true`),
  compiled and isolated. Costs: fake TTY streams (`isTTY = true` is load-bearing) and
  the dropped `_feed` backpressure handling — a small amount of code plus one unowned
  question, not the "~30 lines" an earlier revision claimed.
- **Option B — use `/testing` in production and accept the exposure**, pinning hard.
  Cheaper today, and the *declared, typed* surface — which is not nothing next to
  Option A's dropped backpressure.

The earlier revision presented Option A as strictly better. It is not: it trades a
testing-scoped-but-declared API for a public API plus a behavioural gap. Task 4 should
decide with that trade in view.

For the **frame data** itself, regardless of option:

- **text** ← `getSpanLines()` / `captureSpans()`. **Do not** use `buffers.char`: its
  encoding is unspecified and non-codepoint for wide characters.
- **fg/bg/attributes** ← either spans or `buffers` (decode colours via
  `RGBA.fromArray`, never by reading the `Uint16` slots directly).
- Keep `/testing` in the **test suite** either way — `mockInput`/`mockMouse`/
  `waitForFrame` are genuinely valuable there and a break is cheap.
- **Pin `@opentui/core` exactly** (no `^`) and gate upgrades on a frame-capture
  regression test. The pre-1.0 risk applies to the public surface too — it is smaller
  there, not absent.

## Discrepancies between the plan and the installed package

Recorded per the controller's "installed package is the authority" rule.

1. **`Text({ content: "Hello" })` — plan correct.** Flagged by the plan as possibly
   wrong; it is right. `Text` is a `ProxiedVNode` factory in
   `renderables/composition/constructs.d.ts`, distinct from the `TextRenderable`
   class (whose ctor really is `(ctx, options)`). Both are exported.
2. **The plan's "documented members" list conflates two things.** `renderOnce`,
   `captureSpans`, `captureCharFrame`, `resize`, `mockInput`, `mockMouse`,
   `externalOutput`, `getNativeStats` are **members of the object
   `createTestRenderer()` returns** (`TestRendererSetup`), *not* module exports. The
   module's actual exports are the 12 names printed above. The plan's Step 2 snippet
   prints `Object.keys(mod)` as if to enumerate the former; it enumerates the
   latter. Harmless, but the two lists will not match and that is expected.
3. **`captureSpans()` is not "styled lines and cursor state" loosely — it is
   `CapturedFrame`,** a precise 4-field record. And the crux the plan named
   ("whether 'span' means per-cell attributes or coarser line runs") resolves to
   **coarser line runs** — with lossless expansion, as proven.
4. **`Text(props, ...children)` children are typed `VChild[] | TextNodeRenderable[]`
   — a union, not a mix.** Passing a bare string alongside `vstyles.*` nodes throws
   `TypeError: mount() received an invalid vnode` at
   `renderables/composition/vnode.ts:194`. Unstyled text among styled children must
   still be wrapped, e.g. `vstyles.styled(TextAttributes.NONE, "...")`. Cost one
   failed run; corrected in `src/main.ts`.
5. **Known Risk #1 confirmed incidentally.** An early probe placed outside the spike
   directory failed with
   `error: Cannot find module '@opentui/core/testing' from '...\scratchpad\explore.ts'`
   even with cwd set to the spike dir — Bun resolved the import relative to the
   *importing file's* own directory, exactly as the plan predicts. Not this spike's
   question (it is Spike A's), but it is a live, reproduced data point.
6. **The `/testing` harness reaches into private members.** `renderOnce` uses
   `renderer.loop()` (`private`, `renderer.d.ts:559`) and `renderer._feed` (`private`,
   `:331`). This is invisible from the `.d.ts` of the `/testing` subpath itself and is
   the reason a "public rebuild" is not a mechanical copy of the harness. The public
   equivalent is `intermediateRender()` (`:560`); there is no public equivalent for the
   `_feed` backpressure check.
7. **`OptimizedBuffer.buffers.char` is not documented as an encoding.** The `.d.ts`
   types it `Uint32Array` with no note that values are non-codepoints for wide
   characters. Anything building on it is building on reverse-engineering.
8. **Fake stdout must report `isTTY = true`.** `CliRenderer` branches on it, so a
   headless rebuild needs streams that present as a TTY (`isTTY`, `columns`, `rows`,
   `getColorDepth()`) despite nothing being displayed. Not stated anywhere in the
   package's types.

## Provenance of this document

Revised after review. The verdict (`YES`) is unchanged; three headline supports were
corrected because they claimed more than their evidence showed:

| Claim (earlier revision) | Status now |
| --- | --- |
| "Lossless — proven by reconstruction" (from char/geometry checks only) | **Now measured**: per-cell style vs `buffers` oracle, 1920 cells, 0 mismatches. |
| "Prefer `.buffers` — per-cell, no wcwidth problem" (from array *lengths*) | **Withdrawn / corrected**: values read; `char` is non-codepoint for wide chars; `fg`/`bg` need `RGBA.fromArray`. |
| "`/testing`-free path — every member is public" (used private `loop()`) | **Corrected**: `loop`/`_feed` are private; re-probed to public `intermediateRender()`; backpressure gap disclosed. |
| "Compiled is consistently faster; median 4.07 ms under `bun run`" | **Withdrawn**: `4.07` was untraceable; all four runs now tabulated, no ordering claimed. |
| "Verdict is YES *because* the mitigation exists" | **Corrected**: `/testing` stability is a Step 6 concern, never a verdict input. |

## Reproduce

```bash
cd docs/spikes/02-frame-capture
bun install
bun run src/main.ts                                  # baseline
bun build --compile src/main.ts --outfile probe.exe
./probe.exe                                          # compiled
```

To reproduce the isolation result, copy `probe.exe` alone into an empty directory
and run it there — no `node_modules`, no `opentui.dll`.

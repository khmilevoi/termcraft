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

Two caveats that are real but do not change the verdict, stated up front:

- `captureSpans()` returns **runs, not cells**. Reconstruction to per-cell is a
  mechanical run-expansion, not a direct read. See *Shape* and *Lossless* below.
- The capability ships under `@opentui/core/testing` at **0.4.5**. This is a real
  architectural exposure — see *Step 6*. It is mitigated (a `/testing`-free path
  exists and was proven to work), which is why the verdict is `YES` and not
  `PARTIAL`.

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
| Lossless 80×24 styled grid? | **Yes** — proven by reconstruction, see below. |

### Lossless: how it was proven, and the one catch

Spans are a run-length encoding of a styled grid. The probe did not take that on
faith. It expanded the runs into 1920 per-cell records and compared the
reconstructed characters byte-for-byte against `captureCharFrame()`, which is the
renderer's own view of the same grid. Three independent checks, all on an 80×24
frame mixing fg, bg, bold, italic and wide CJK text:

- every row's spans sum to exactly `cols` (spans **tile** the row — no gaps);
- expansion yields exactly 24 rows × 80 cells;
- `reconstructed chars === captureCharFrame()` → `true`.

**The catch — wide characters.** `span.width` is display width, not codepoint
count. `"日本語ab"` is 5 codepoints but `width: 8`. So run-expansion is only
mechanical if the consumer re-derives each character's display width; a naive
`[...text]` walk would misalign every column after the first CJK glyph. The probe
used `Bun.stringWidth()` per character and cross-checked the derived total against
`span.width` on every span; no mismatch was ever reported. So expansion is
reliable, but it is **an algorithm the host must own**, and it must agree with the
renderer's configured `widthMethod` (`"wcwidth" | "unicode"`). This is the single
place §4.2's protocol can silently corrupt a frame.

### A better path than RLE, on the public API

`captureSpans()` is not the only style-carrying path, and not the most direct one.
`OptimizedBuffer` exposes raw **per-cell** typed arrays (`buffer.d.ts:22-27`):

```ts
get buffers(): {
    char: Uint32Array;        // 1 per cell
    fg: Uint16Array;          // 4 per cell (RGBA)
    bg: Uint16Array;          // 4 per cell (RGBA)
    attributes: Uint32Array;  // 1 per cell
};
getRealCharBytes(addLineBreaks?: boolean): Uint8Array;
getSpanLines(): CapturedLine[];
```

Measured at 80×24: `char: 1920, fg: 7680, bg: 7680, attributes: 1920` — exactly
80×24 cells, with fg/bg at 4 components each. This is §4.2's "char + fg + bg +
attributes" **directly, per cell, with no run-expansion and no wcwidth problem**,
and it is on the public `@opentui/core` surface, not `/testing`.

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

(`captureCharFrame` output trimmed here to its first line; the full 40×10
space-padded block is in the task report. `stdout.isTTY: false` confirms no
physical terminal.)

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

```
=== VERDICT PROBE: lossless 80x24 reconstruction ===
cols = 80  rows = 24  lines = 24
cursor = [1,1]
all rows tile to cols: true  widths: [80]
grid is 24x80: true  row lengths: [80]
reconstructed chars === captureCharFrame(): true
LOSSLESS = true
--- sample styled cells from row 0 (char + fg + bg + attributes) ---
  cell[0][ 0] = "R" fg=[255,0,0,255] bg=[0,0,0,0] attr=0
  cell[0][ 3] = "G" fg=[255,255,255,255] bg=[0,255,0,255] attr=0
  cell[0][ 6] = "B" fg=[255,255,255,255] bg=[0,0,0,0] attr=1
  cell[0][10] = "I" fg=[255,255,255,255] bg=[0,0,0,0] attr=4
  cell[0][14] = "p" fg=[255,255,255,255] bg=[0,0,0,0] attr=0
  cell[0][20] = "日" fg=[255,255,255,255] bg=[0,0,0,0] attr=0
```

### Step 4 — `bun build --compile` on Windows (verbatim)

This was the highest-risk step and the one the spec never mentions. **The native
Zig core loads from the single-file executable.**

```
$ bun build --compile src/main.ts --outfile probe.exe
  [44ms]  bundle  20 modules
 [496ms] compile  probe.exe
```

Produces `probe.exe`, 102.05 MB. Run from an **isolated** directory containing
only `probe.exe` — no `node_modules`, and `Get-ChildItem -Recurse -Filter *.dll`
returns `0`:

```
=== RUNTIME ===
bun version: 1.3.14
execPath: ...\scratchpad\isolated\probe.exe
isCompiledBinary: true
embeddedFiles: 14
platform: win32 x64
stdout.isTTY: false
```

...followed by every section producing results **identical** to `bun run`:

```
=== VERDICT PROBE: lossless 80x24 reconstruction ===
cols = 80  rows = 24  lines = 24
all rows tile to cols: true  widths: [80]
grid is 24x80: true  row lengths: [80]
reconstructed chars === captureCharFrame(): true
LOSSLESS = true
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
- **Wall clock, `createTestRenderer` + `renderOnce` + capture @ 80×24:**
  **median 2.20 ms** compiled (min 2.03, max 2.98); **median 4.07–5.49 ms** under
  `bun run`. The compiled binary is consistently *faster*.

  **Export is seconds, not minutes** (§3.7 renders a fresh host per page per size).
  At ~2.2 ms per fresh host, 100 pages × 5 sizes = 500 renders ≈ **1.1 s**. This is
  not a bottleneck and needs no host-reuse optimization.

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

**But a non-testing headless path does exist, and it was proven — this is the
mitigation.** `createTestRenderer` turns out to be a thin harness over public API.
Read from the installed package:

```js
// testing.bun.js — setupTestRenderer
const stdin = config.stdin || createTestStdin();
const stdout = config.stdout || createTestStdout(width, height);
return new CliRenderer(stdin, stdout, width, height, {
  ...config,
  bufferedOutput: config.bufferedOutput ?? "memory"
});

// testing.bun.js:696 — captureSpans
captureSpans: () => {
  const currentBuffer = renderer.currentRenderBuffer;
  const lines = currentBuffer.getSpanLines();
  const cursorState = renderer.getCursorState();
  return { cols: currentBuffer.width, rows: currentBuffer.height,
           cursor: [cursorState.x, cursorState.y], lines };
}
```

Every member it touches is on the **public** `@opentui/core` surface:

| Member | Public location |
| --- | --- |
| `CliRenderer` ctor `(stdin, stdout, w, h, config)` | `renderer.d.ts:362` |
| `createCliRenderer(config)` | `renderer.d.ts:177` |
| `bufferedOutput: "stdout" \| "memory"` | `renderer.d.ts:21`, `zig.d.ts:75` |
| `renderer.currentRenderBuffer` | `renderer.d.ts:217` |
| `renderer.getCursorState()` | `renderer.d.ts:536` |
| `OptimizedBuffer.getSpanLines()` | `buffer.d.ts:43` |
| `OptimizedBuffer.getRealCharBytes()` | `buffer.d.ts:42` |
| `OptimizedBuffer.buffers` (per-cell arrays) | `buffer.d.ts:22-27` |
| `CapturedFrame` / `CapturedLine` / `CapturedSpan` | `types.d.ts` — exported from the **main** index, not `/testing` |

The probe rebuilt the headless path using **only** `@opentui/core` — no `/testing`
import — with a hand-rolled `Writable` stdout and `Readable` stdin, and got the
same styled frame:

```
=== STEP 6: /testing-free headless path (public API only) ===
createCliRenderer/CliRenderer headless: OK
public getSpanLines() span[0] = {"text":"PUBLIC","width":6,"attributes":1,"fg":[255,0,0,255],"bg":[0,0,255,255]}
frame cols=80 rows=24 lines=24 tiles=true
raw per-cell typed arrays via buf.buffers: {"char":1920,"fg":7680,"bg":7680,"attributes":1920,"expectedCells":1920}
STEP6_TESTING_FREE_PATH_WORKS = true
```

Notably, `CapturedFrame` — the very type `captureSpans()` returns — lives in the
main `types.d.ts`, and `getSpanLines()` is public on `OptimizedBuffer`. The
*capture* capability is public; only the *harness* is testing-scoped.

**Recommendation for Task 4.** Do not build the production design host on
`@opentui/core/testing`. Build it on `CliRenderer` + `bufferedOutput: "memory"` +
`currentRenderBuffer.getSpanLines()` (or `.buffers` for direct per-cell access),
which is public, ~30 lines to own, and demonstrated working here. Keep `/testing`
where it belongs — in our test suite, where `mockInput`/`mockMouse`/`waitForFrame`
are genuinely valuable and a break is cheap. The residual pre-1.0 risk on the
public surface remains and should be managed by **pinning `@opentui/core` exactly**
(no `^`) and gating upgrades on a frame-capture regression test.

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

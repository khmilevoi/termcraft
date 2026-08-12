# Authoring a termcraft page

A page is one TSX module. Its legal imports are `@termcraft/runtime` — see `runtime.d.ts`
alongside this file for the exact exported names and their types — and a relative import
(`./`, `../`) that resolves to a real file inside this project's own tree, such as the design
system's token accessor. Nothing else is a legal import.

## Minimal shape

    import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"

    export const meta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
    })

    export default reatomComponent(function Page() {
      return (
        <Panel id="root" title="Dashboard">
          <Text id="hello">Hello</Text>
        </Panel>
      )
    })

`meta` must be a plain object literal of constants — no computed values. Every visible
component needs a stable, unique `id`; selection, pins, and chat references all address the
design by id, and an id should survive edits across turns whenever the element itself
survives.

`meta.theme` is optional: omit it and the page renders in the project's default theme. Set it
only to pin the page to a theme `design/system/design-system.json` actually declares.

## State

Hold state in named Reatom atoms, computeds, and actions — not React hooks.
`reatomComponent` re-renders when the atoms it reads change. Keep helper models and
components in the same file as the page that uses them; pages never import each other.

**Read `REATOM.md`, next to this file, before you write any of it.** This runtime is Reatom
**v1001**, not the v3 that most Reatom code you have seen uses: there is no `ctx` parameter
and no `.spy`. Reading an atom is `count()`, writing it is `count.set(1)`, and
`reatomComponent`'s callback receives React props — never a context. Getting this wrong
typechecks and then throws on the first render.

## Layout and style

Layout is ordinary flexbox: `direction`, `grow`/`shrink`/`basis`, gaps, padding, and
alignment as style props on containers and primitives. `Row`/`Column` are flex-direction
presets; `Spacer` is `flexGrow: 1`.

Colors are concrete values, read from this project's own design system. The names and the
values live in `design/system/design-system.json`; `design/system/tokens.ts` is the typed
accessor pages import.

    import { useTokens } from "../system/tokens"

    export default reatomComponent(function Page() {
      const t = useTokens()
      return <Text id="title" color={t.accent}>Dashboard</Text>
    })

Call `useTokens()` **inside the component**, never at module scope: at module scope it captures
one theme's values forever, and the Gate warns about it.

A token name that the manifest does not declare is a fatal type error — `t.brandBlu` does not
compile. That is the whole point: the set of names is the project's, not the runtime's, and it
is still fully checked.

Every theme declares these seventeen **core roles**, and the component catalog binds to them —
`Panel` with no `borderColor` means `border`, a `Gauge` fill means `accent`, status semantics
mean `success`/`warning`/`danger`:

`background`, `surface`, `foreground`, `foregroundMuted`, `foregroundFaint`, `border`, `line`,
`accent`, `accentHi`, `accentDim`, `selection`, `selectionFg`, `success`, `warning`, `danger`,
`dangerDim`, `statusBg`.

Beyond the core, a project may declare any number of its own names — `brandBlue`,
`chartSeries1`, whatever the design needs. Read this turn's system prompt for the ones THIS
project has, with their values. Adding one means editing `design-system.json`; a turn that adds
a token and a turn that uses it can be the same turn.

A raw hex string is legal where a `Color` is expected, but it is almost always the wrong answer:
a hue written into a page is a hue no theme can change. Add it to the design system and read it
as a token.

## Time and the sealed render

A page renders once per commit. There is no tick, no animation frame, no interval, no
clock. Nothing in the runtime calls your component again on its own. Any value that would
change with time lives in an atom and advances only from an action.

The Gate flags: `Date.now()`, `performance.now()`, `new Date()` with no arguments,
`Math.random()`, `setTimeout`, `setInterval`, `setImmediate`, `requestAnimationFrame`.

A seeded `new Date(ms)` or `new Date(year, month, day)` is left alone — it reads no clock, so
flagging it would only teach you to avoid dates instead of avoiding the clock.

A worked stopwatch, because it is the canonical case that trips this rule:

    // elapsedMsAtom advances only from start/stop/lap. No wall-clock delta anywhere: there is no
    // clock to read and no tick to read it on.
    const elapsedMsAtom = atom(0, "elapsedMsAtom")
    const lapsAtom = atom<readonly number[]>([], "lapsAtom")
    const tick = action((ms: number) => elapsedMsAtom.set(elapsedMsAtom() + ms), "tick")
    const lap = action(() => lapsAtom.set([...lapsAtom(), elapsedMsAtom()]), "lap")

A stopwatch in a design preview advances when something advances it, and a page cannot
advance itself. That is the runtime's shape, not a missing feature.

## Code and rendered markdown

`Code` shows source text; `Markdown` renders a markdown document, including its fenced code
blocks. Both need only `id` and `content`.

    <Code id="snippet" language="typescript" content={source} />
    <Markdown id="notes" content={doc} />

Syntax colours come from the project's theme. There is no colour prop, no style prop, and no
way to pass a palette — a page cannot recolour syntax, and does not need to.

`Code` takes an optional `language`. `Markdown` takes none: a fenced block names its own
language in its info string.

Only `typescript`, `javascript`, `markdown` and `zig` highlight. Any other language — and
`Code` with no `language` at all — renders as plain themed text. That is a normal outcome, not
an error: nothing is downloaded at runtime, so a build ships exactly these grammars.

## What not to do

See "Time and the sealed render" above for the determinism rule. Legal imports are
`@termcraft/runtime` and a relative import into this project's own tree, nothing else — see
`runtime.d.ts` and this turn's system prompt for the exact allowlist.

A colour prop bound to a token _name_ (`color="accent"`) no longer type-checks. Write
`color={t.accent}`.

## Element catalog additions

Beyond the components named above, the runtime exposes these wrappers over OpenTUI's remaining
elements. `runtime.d.ts` alongside this file carries their exact prop types; every one takes a
mandatory `id`.

- `Slider` — a draggable value track. Required: `id`, `orientation` (`"horizontal"` |
  `"vertical"`), `value`. Optional `min`/`max` (0/100), `trackColor`/`fillColor`,
  `width`/`height`, `onChange(value)`. Its rendered position always comes from `value`, so an
  export snapshot is deterministic.
- `ScrollBar` — a proportional scroll indicator; a leaf, it takes no children. Required: `id`,
  `orientation`, `contentSize`, `viewportSize`, `position` (all in cells). Optional
  `trackColor`/`thumbColor`/`arrowColor`, `showArrows` (off by default), `width`/`height`,
  `onScroll(position)`.
- `TextTable` — a grid of styled text cells that measures its own column widths and wraps inside
  a cell. Required: `id`, `rows` (a matrix whose cells are a plain string or a list of
  `{ text, color?, background?, bold?, italic?, underline? }` runs). Optional `borders` (off),
  `borderColor`, `textColor`, `background`, `columnGap` (1), `wrap` (`"word"`), `cellPadding`,
  `width`/`height`. Row selection belongs to `Table`, not here.
- `FrameBuffer` — a raw cell buffer for bespoke graphics; the last escape hatch. Required: `id`,
  `width`, `height`, and `draw(surface)`, which paints through `clear`, `setCell`, `drawText` and
  `fillRect`. It renders nothing until `draw` paints into it, and writes outside the buffer are
  dropped.

# Authoring a termcraft page

A page is one TSX module. It imports only from `@termcraft/runtime` — see `runtime.d.ts`
alongside this file for the exact exported names and their types.

## Minimal shape

    import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"

    export const meta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
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

Colors are semantic token names from one closed set — never raw hex. The complete set, and
the only names that resolve:

`background`, `surface`, `foreground`, `foregroundMuted`, `foregroundFaint`, `border`,
`line`, `accent`, `accentHi`, `accentDim`, `selection`, `selectionFg`, `success`, `warning`,
`danger`, `dangerDim`, `statusBg`.

`accent` is the primary highlight (amber); `success`/`warning`/`danger` are the semantic
status hues; `foregroundMuted`/`foregroundFaint` are the de-emphasis steps. The MVP ships a
single theme (`dark-default`), so a page cannot offer a real theme switch — it can only
choose which of these tokens it uses.

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

## What not to do

See "Time and the sealed render" above for the determinism rule. No imports beyond
`@termcraft/runtime` — see `runtime.d.ts` and this turn's system prompt for the exact
allowlist.

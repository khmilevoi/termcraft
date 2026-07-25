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

## Layout and style

Layout is ordinary flexbox: `direction`, `grow`/`shrink`/`basis`, gaps, padding, and
alignment as style props on containers and primitives. `Row`/`Column` are flex-direction
presets; `Spacer` is `flexGrow: 1`. Colors come from the closed palette-token set
(`background`, `surface`, `text`, `text-muted`, `text-faint`, `border`, `primary`, `accent`,
`selection`, `ok`, `error`) — reach them through runtime context rather than raw hex values.

## What not to do

No timers or randomness outside animation guarded by the export flag — the first frame must
be deterministic. No imports beyond `@termcraft/runtime` — see `runtime.d.ts` and this
turn's system prompt for the exact allowlist.
